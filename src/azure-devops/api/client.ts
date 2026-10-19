import { authorizationHeader, type AzureDevopsAuth } from "../token";
import {
  AZURE_DEVOPS_DEFAULT_API_VERSION,
  normalizeCollectionUri,
} from "./config";
import type {
  AdoCreateThreadRequest,
  AdoComment,
  AdoIteration,
  AdoIterationChange,
  AdoIterationChangesPage,
  AdoListResponse,
  AdoPullRequest,
  AdoThread,
} from "../types";

/**
 * Azure DevOps puts the useful part of an error in the JSON body
 * (`{"message":"TF401027: You need the Git 'PullRequestContribute'
 * permission ..."}`), so surface that rather than the status text.
 */
function describeErrorBody(body: unknown): string {
  if (body === null || body === undefined || body === "") return "";
  if (typeof body === "object" && body !== null && "message" in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

export class AzureDevopsApiError extends Error {
  status: number;
  body: unknown;
  method: string;
  url: string;

  constructor(
    status: number,
    method: string,
    url: string,
    statusText: string,
    body: unknown,
  ) {
    const detail = describeErrorBody(body);
    super(
      `Azure DevOps API ${status} on ${method} ${url}: ${statusText}${detail ? ` - ${detail}` : ""}`,
    );
    this.name = "AzureDevopsApiError";
    this.status = status;
    this.body = body;
    this.method = method;
    this.url = url;
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type AzureDevopsClientOptions = {
  /** e.g. https://dev.azure.com/org or https://ado.contoso.com/tfs/DefaultCollection */
  collectionUri: string;
  /** Project name or id. */
  project: string;
  /** Repository id (GUID) or name. */
  repositoryId: string;
  auth: AzureDevopsAuth;
  apiVersion?: string;
  fetch?: FetchLike;
};

type RequestOptions = {
  method?: string;
  json?: unknown;
  query?: Record<string, string | number | undefined>;
};

type RawResponse<T> = { data: T; headers: Headers };

const CONTINUATION_HEADER = "x-ms-continuationtoken";
const ITERATION_CHANGES_PAGE_SIZE = 2000;
const MAX_PAGES = 1000;

export class AzureDevopsClient {
  readonly collectionUri: string;
  readonly project: string;
  readonly repositoryId: string;
  readonly apiVersion: string;
  private readonly auth: AzureDevopsAuth;
  private readonly fetchImpl: FetchLike;

  constructor(options: AzureDevopsClientOptions) {
    this.collectionUri = normalizeCollectionUri(options.collectionUri);
    this.project = options.project;
    this.repositoryId = options.repositoryId;
    this.auth = options.auth;
    this.apiVersion = options.apiVersion ?? AZURE_DEVOPS_DEFAULT_API_VERSION;
    this.fetchImpl =
      options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  /** `{collection}/{project}/_apis/git/repositories/{repo}` */
  repositoryApiUrl(): string {
    return (
      `${this.collectionUri}/${encodeURIComponent(this.project)}` +
      `/_apis/git/repositories/${encodeURIComponent(this.repositoryId)}`
    );
  }

  private pullRequestUrl(pullRequestId: number): string {
    return `${this.repositoryApiUrl()}/pullRequests/${pullRequestId}`;
  }

  private buildUrl(base: string, query: RequestOptions["query"] = {}): string {
    const url = new URL(base);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.set("api-version", this.apiVersion);
    return url.toString();
  }

  private async send<T>(
    base: string,
    options: RequestOptions = {},
  ): Promise<RawResponse<T>> {
    const method = options.method ?? "GET";
    const url = this.buildUrl(base, options.query);
    const headers: Record<string, string> = {
      Authorization: authorizationHeader(this.auth),
      Accept: "application/json",
    };
    let body: string | undefined;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }

    const response = await this.fetchImpl(url, { method, headers, body });
    const text = await response.text();

    if (!response.ok) {
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // keep the raw text
      }
      throw new AzureDevopsApiError(
        response.status,
        method,
        url,
        response.statusText || "Request failed",
        parsed,
      );
    }

    if (response.status === 204 || text === "") {
      return { data: undefined as unknown as T, headers: response.headers };
    }

    // An invalid or expired PAT gets a 203 with the HTML sign-in page instead
    // of a 401, so a non-JSON success body is an auth failure in disguise.
    try {
      return { data: JSON.parse(text) as T, headers: response.headers };
    } catch {
      throw new AzureDevopsApiError(
        response.status,
        method,
        url,
        "Expected a JSON response but got something else (an invalid or expired token " +
          "makes Azure DevOps return its HTML sign-in page)",
        null,
      );
    }
  }

  private async request<T>(base: string, options?: RequestOptions) {
    return (await this.send<T>(base, options)).data;
  }

  /**
   * Follows the `x-ms-continuationtoken` response header, which Azure DevOps
   * uses for list endpoints that page, by echoing it back as the
   * `continuationToken` query parameter.
   */
  private async listAll<T>(
    base: string,
    query: RequestOptions["query"] = {},
  ): Promise<T[]> {
    const items: T[] = [];
    let continuationToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, headers } = await this.send<AdoListResponse<T>>(base, {
        query: { ...query, continuationToken },
      });
      items.push(...(data?.value ?? []));
      const next = headers.get(CONTINUATION_HEADER);
      if (!next || next === continuationToken) return items;
      continuationToken = next;
    }
    throw new Error(`Azure DevOps pagination did not terminate for ${base}`);
  }

  getPullRequest(pullRequestId: number): Promise<AdoPullRequest> {
    return this.request<AdoPullRequest>(this.pullRequestUrl(pullRequestId));
  }

  listIterations(pullRequestId: number): Promise<AdoIteration[]> {
    return this.listAll<AdoIteration>(
      `${this.pullRequestUrl(pullRequestId)}/iterations`,
    );
  }

  /**
   * Changes in one iteration relative to its merge base. The endpoint pages
   * with `$top`/`$skip` and reports the next window in `nextSkip`/`nextTop`.
   */
  async listIterationChanges(
    pullRequestId: number,
    iterationId: number,
  ): Promise<AdoIterationChange[]> {
    const base = `${this.pullRequestUrl(pullRequestId)}/iterations/${iterationId}/changes`;
    const entries: AdoIterationChange[] = [];
    let top = ITERATION_CHANGES_PAGE_SIZE;
    let skip = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await this.request<AdoIterationChangesPage>(base, {
        query: { $top: top, $skip: skip },
      });
      entries.push(...(data?.changeEntries ?? []));
      if (!data?.nextSkip || data.nextSkip <= skip) return entries;
      skip = data.nextSkip;
      top = data.nextTop || top;
    }
    throw new Error(`Azure DevOps pagination did not terminate for ${base}`);
  }

  listThreads(pullRequestId: number): Promise<AdoThread[]> {
    return this.listAll<AdoThread>(
      `${this.pullRequestUrl(pullRequestId)}/threads`,
    );
  }

  createThread(
    pullRequestId: number,
    thread: AdoCreateThreadRequest,
  ): Promise<AdoThread> {
    return this.request<AdoThread>(
      `${this.pullRequestUrl(pullRequestId)}/threads`,
      { method: "POST", json: thread },
    );
  }

  updateComment(
    pullRequestId: number,
    threadId: number,
    commentId: number,
    content: string,
  ): Promise<AdoComment> {
    return this.request<AdoComment>(
      `${this.pullRequestUrl(pullRequestId)}/threads/${threadId}/comments/${commentId}`,
      { method: "PATCH", json: { content } },
    );
  }
}
