/**
 * Minimal HTTP layer shared by the Bitbucket Cloud and Data Center clients:
 * auth header, JSON encoding, redirects, retry on rate limits and transient
 * 5xx (writes only when the server says it did not process them), and
 * errors that carry the API's own message but never the credentials.
 */

export type BitbucketAuth = {
  /** Full `Authorization` header value. Never log it. */
  header: string;
};

export type BitbucketHttpOptions = {
  auth: BitbucketAuth;
  /** Delay before retrying 429/5xx responses; tests pass 0. */
  retryDelayMs?: number;
  maxRetries?: number;
};

/**
 * Pull the human-readable part out of an error body. Cloud returns
 * `{"type":"error","error":{"message":...,"detail":...}}`, Data Center
 * returns `{"errors":[{"message":...}]}`.
 */
export function describeBitbucketErrorBody(body: unknown): string {
  if (body === null || body === undefined || body === "") return "";
  if (typeof body === "object") {
    const record = body as Record<string, unknown>;
    const cloud = record.error as Record<string, unknown> | undefined;
    if (cloud && typeof cloud.message === "string") {
      const detail =
        typeof cloud.detail === "string" && cloud.detail
          ? ` (${cloud.detail})`
          : "";
      return `${cloud.message}${detail}`;
    }
    if (Array.isArray(record.errors)) {
      const messages = record.errors
        .map((e) =>
          e && typeof e === "object"
            ? (e as Record<string, unknown>).message
            : null,
        )
        .filter((m): m is string => typeof m === "string" && m.length > 0);
      if (messages.length > 0) return messages.join("; ");
    }
  }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

export class BitbucketApiError extends Error {
  status: number;
  body: unknown;

  constructor(
    status: number,
    statusText: string,
    method: string,
    url: string,
    body: unknown,
  ) {
    const detail = describeBitbucketErrorBody(body);
    // Drop the query string: it can be long and never holds anything useful.
    const where = `${method} ${url.split("?")[0]}`;
    super(
      `Bitbucket API ${status}: ${statusText || "Request failed"} (${where})${detail ? ` - ${detail}` : ""}`,
    );
    this.name = "BitbucketApiError";
    this.status = status;
    this.body = body;
  }
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
const MAX_REDIRECTS = 5;

/**
 * A POST that timed out at a gateway (502/504) or failed with a bare 503
 * may already have been committed, so repeating it can double-post a
 * comment. Only 429 and a 503 carrying Retry-After are explicit "not
 * processed, try later" answers.
 */
function shouldRetry(method: string, response: Response): boolean {
  if (!RETRYABLE.has(response.status)) return false;
  if (IDEMPOTENT.has(method)) return true;
  if (response.status === 429) return true;
  return response.status === 503 && response.headers.has("Retry-After");
}

function isBitbucketCloudHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "bitbucket.org" || host.endsWith(".bitbucket.org");
}

/**
 * fetch drops `Authorization` on cross-origin redirects (Cloud's PR diff
 * endpoint redirects to another resource), so redirects are followed by
 * hand. Credentials go only to the same host or between Bitbucket Cloud
 * hosts, and never over a downgrade to plain http.
 */
export function mayForwardCredentials(from: URL, to: URL): boolean {
  if (from.protocol === "https:" && to.protocol !== "https:") return false;
  const fromHost = from.hostname.toLowerCase();
  const toHost = to.hostname.toLowerCase();
  if (fromHost === toHost) return true;
  return isBitbucketCloudHost(fromHost) && isBitbucketCloudHost(toHost);
}

export type RequestInit = {
  method?: string;
  json?: unknown;
  accept?: string;
};

export class BitbucketHttp {
  private readonly auth: BitbucketAuth;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;

  constructor(options: BitbucketHttpOptions) {
    this.auth = options.auth;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  /** One request, following redirects manually. */
  private async fetchFollowing(
    url: string,
    method: string,
    baseHeaders: Record<string, string>,
    body: string | undefined,
  ): Promise<{ response: Response; url: string }> {
    const origin = new URL(url);
    let current = origin;
    let currentMethod = method;
    let currentBody = body;
    for (let hop = 0; ; hop++) {
      const headers = { ...baseHeaders };
      if (mayForwardCredentials(origin, current)) {
        headers.Authorization = this.auth.header;
      }
      if (currentBody === undefined) delete headers["Content-Type"];
      const response = await fetch(current.toString(), {
        method: currentMethod,
        headers,
        body: currentBody,
        redirect: "manual",
      });
      const location = response.headers.get("Location");
      if (
        response.status < 300 ||
        response.status >= 400 ||
        !location ||
        hop >= MAX_REDIRECTS
      ) {
        return { response, url: current.toString() };
      }
      await response.text().catch(() => "");
      current = new URL(location, current);
      // 303, and 301/302 after a POST, turn into a GET as browsers do.
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          currentMethod === "POST")
      ) {
        currentMethod = "GET";
        currentBody = undefined;
      }
    }
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {
      Accept: init.accept ?? "application/json",
    };
    let body: string | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }

    for (let attempt = 0; ; attempt++) {
      const { response, url: finalUrl } = await this.fetchFollowing(
        url,
        method,
        headers,
        body,
      );
      if (response.ok) return response;

      if (shouldRetry(method, response) && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 30) * 1000
            : this.retryDelayMs * 2 ** attempt;
        // Drain the body so the connection can be reused.
        await response.text().catch(() => "");
        if (this.retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, delay));
        }
        continue;
      }

      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // keep the raw text
      }
      throw new BitbucketApiError(
        response.status,
        response.statusText,
        method,
        finalUrl,
        parsed,
      );
    }
  }

  async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.send(url, init);
    if (response.status === 204) return undefined as unknown as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async text(url: string, init: RequestInit = {}): Promise<string> {
    const response = await this.send(url, { accept: "text/plain", ...init });
    return response.text();
  }
}
