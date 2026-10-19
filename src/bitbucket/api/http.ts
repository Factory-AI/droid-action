/**
 * Minimal HTTP layer shared by the Bitbucket Cloud and Data Center clients:
 * auth header, JSON encoding, retry on rate limits and transient 5xx, and
 * errors that carry the API's own message but never the credentials.
 */

export type BitbucketAuth = {
  scheme: "bearer" | "basic";
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

  private async send(url: string, init: RequestInit): Promise<Response> {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {
      Authorization: this.auth.header,
      Accept: init.accept ?? "application/json",
    };
    let body: string | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }

    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { method, headers, body });
      if (response.ok) return response;

      if (RETRYABLE.has(response.status) && attempt < this.maxRetries) {
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
        url,
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
