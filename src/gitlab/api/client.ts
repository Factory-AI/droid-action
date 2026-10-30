import { GITLAB_API_URL } from "./config";
import type {
  GitlabMr,
  GitlabMrChanges,
  GitlabNote,
  GitlabDiscussion,
  GitlabPosition,
  GitlabUser,
  GitlabAward,
  GitlabProject,
  GitlabBranch,
  GitlabCommitAction,
} from "../types";
import {
  redactDeep,
  redactSecrets,
  secretValuesFromEnv,
} from "../../utils/redact-credentials";
import { retryWithBackoff } from "../../utils/retry";

/**
 * The interesting part of a GitLab error is the response body (e.g.
 * `{"message":"400 Bad request - Note {:line_code=>[...]}"}`), not the
 * status text, so surface it in the error message where CI logs show it.
 */
function describeErrorBody(body: unknown): string {
  if (body === null || body === undefined || body === "") {
    return "";
  }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

export class GitlabApiError extends Error {
  status: number;
  body: unknown;
  retryAfterMs?: number;

  constructor(
    status: number,
    message: string,
    body: unknown,
    secrets: readonly string[] = secretValuesFromEnv(),
  ) {
    const safeBody = redactDeep(body, secrets);
    const detail = describeErrorBody(safeBody);
    super(
      redactSecrets(
        `GitLab API ${status}: ${message}${detail ? ` - ${detail}` : ""}`,
        secrets,
      ),
    );
    this.name = "GitlabApiError";
    this.status = status;
    this.body = safeBody;
  }
}

type RequestInitWithJson = Omit<RequestInit, "body"> & { json?: unknown };

export class GitlabClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(token: string, baseUrl: string = GITLAB_API_URL) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private secrets(): string[] {
    return [...new Set([this.token, ...secretValuesFromEnv()])].sort(
      (a, b) => b.length - a.length,
    );
  }

  private async request<T>(
    path: string,
    init: RequestInitWithJson = {},
  ): Promise<T> {
    if (!init.method || init.method === "GET") {
      let retryAt = 0;
      return retryWithBackoff(
        async () => {
          const remaining = retryAt - Date.now();
          if (remaining > 0)
            await new Promise((resolve) => setTimeout(resolve, remaining));
          try {
            return await this.requestOnce<T>(path, init);
          } catch (error) {
            retryAt =
              error instanceof GitlabApiError &&
              error.retryAfterMs !== undefined
                ? Date.now() + error.retryAfterMs
                : 0;
            throw error;
          }
        },
        {
          initialDelayMs: 200,
          maxDelayMs: 1000,
          shouldRetry: (error) =>
            error instanceof GitlabApiError &&
            (error.status === 429 || error.status >= 500),
        },
      );
    }
    // Writes are not blindly retried: an interrupted response can represent
    // an already-created discussion, commit, or merge request.
    return this.requestOnce<T>(path, init);
  }

  private async requestOnce<T>(
    path: string,
    init: RequestInitWithJson,
  ): Promise<T> {
    // Only API-relative paths: an absolute URL would send PRIVATE-TOKEN to
    // whatever host it names.
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error(
        `GitlabClient only requests paths relative to its API base URL; refusing "${path.slice(0, 100)}"`,
      );
    }

    const { json, headers: rawHeaders, ...rest } = init;
    const secrets = this.secrets();
    const headers: Record<string, string> = {
      "PRIVATE-TOKEN": this.token,
      Accept: "application/json",
      ...(rawHeaders as Record<string, string> | undefined),
    };

    let body: string | undefined;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      // Every string in a request body can carry model output, which can
      // quote anything a tool printed, so the whole payload is redacted
      // rather than trusting each caller to.
      body = JSON.stringify(redactDeep(json, secrets));
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...rest,
      headers,
      body,
      // A redirect to another host would carry PRIVATE-TOKEN with it.
      redirect: "error",
    });

    if (!response.ok) {
      let parsed: unknown = null;
      const text = await response.text();
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      const error = new GitlabApiError(
        response.status,
        response.statusText || "Request failed",
        parsed,
        secrets,
      );
      const hint = response.headers.get("Retry-After");
      if (response.status === 429 && hint?.trim()) {
        const seconds = Number(hint);
        const delay = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(hint) - Date.now();
        if (Number.isFinite(delay))
          error.retryAfterMs = Math.min(30000, Math.max(0, delay));
      }
      throw error;
    }

    if (response.status === 204) {
      return undefined as unknown as T;
    }

    return (await response.json()) as T;
  }

  private projectPath(projectId: string | number): string {
    return `/projects/${encodeURIComponent(String(projectId))}`;
  }

  private async pages<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<T[]>(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100${page > 1 ? `&page=${page}` : ""}`,
      );
      if (!Array.isArray(batch))
        throw new Error("GitLab returned an invalid paginated response");
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }

  getMr(projectId: string | number, mrIid: number): Promise<GitlabMr> {
    return this.request<GitlabMr>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}`,
    );
  }

  getMrChanges(
    projectId: string | number,
    mrIid: number,
  ): Promise<GitlabMrChanges> {
    return this.request<GitlabMrChanges>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/changes`,
    );
  }

  listNotes(projectId: string | number, mrIid: number): Promise<GitlabNote[]> {
    return this.pages<GitlabNote>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/notes`,
    );
  }

  getCurrentUser(): Promise<GitlabUser> {
    return this.request<GitlabUser>("/user");
  }

  getNote(
    projectId: string | number,
    mrIid: number,
    noteId: number,
  ): Promise<GitlabNote> {
    return this.request<GitlabNote>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/notes/${noteId}`,
    );
  }

  createNote(
    projectId: string | number,
    mrIid: number,
    body: string,
  ): Promise<GitlabNote> {
    return this.request<GitlabNote>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/notes`,
      { method: "POST", json: { body } },
    );
  }

  updateNote(
    projectId: string | number,
    mrIid: number,
    noteId: number,
    body: string,
  ): Promise<GitlabNote> {
    return this.request<GitlabNote>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/notes/${noteId}`,
      { method: "PUT", json: { body } },
    );
  }

  createDiscussionOnDiff(
    projectId: string | number,
    mrIid: number,
    body: string,
    position: GitlabPosition,
  ): Promise<GitlabDiscussion> {
    return this.request<GitlabDiscussion>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/discussions`,
      { method: "POST", json: { body, position } },
    );
  }

  updateMrDescription(
    projectId: string | number,
    mrIid: number,
    description: string,
  ): Promise<GitlabMr> {
    return this.request<GitlabMr>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}`,
      { method: "PUT", json: { description } },
    );
  }

  listDiscussions(
    projectId: string | number,
    mrIid: number,
  ): Promise<GitlabDiscussion[]> {
    return this.pages<GitlabDiscussion>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/discussions`,
    );
  }

  replyToDiscussion(
    projectId: string | number,
    mrIid: number,
    discussionId: string,
    body: string,
  ): Promise<GitlabNote> {
    return this.request(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/discussions/${encodeURIComponent(discussionId)}/notes`,
      { method: "POST", json: { body } },
    );
  }

  resolveDiscussion(
    projectId: string | number,
    mrIid: number,
    discussionId: string,
  ): Promise<GitlabDiscussion> {
    return this.request(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/discussions/${encodeURIComponent(discussionId)}`,
      { method: "PUT", json: { resolved: true } },
    );
  }

  compare(
    projectId: string | number,
    from: string,
    to: string,
  ): Promise<{
    diffs: GitlabMrChanges["changes"];
    compare_timeout?: boolean;
    compare_same_ref?: boolean;
  }> {
    return this.request(
      `${this.projectPath(projectId)}/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&straight=true`,
    );
  }

  async getRepositoryFile(
    projectId: string | number,
    filePath: string,
    ref: string,
  ): Promise<string> {
    const file = await this.request<{ content: string; encoding: string }>(
      `${this.projectPath(projectId)}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`,
    );
    if (file.encoding !== "base64" || typeof file.content !== "string")
      throw new Error("Unsupported GitLab repository file response");
    return Buffer.from(file.content, "base64").toString("utf8");
  }

  getProject(projectId: string | number): Promise<GitlabProject> {
    return this.request(this.projectPath(projectId));
  }

  getMember(
    projectId: string | number,
    userId: number,
  ): Promise<{ access_level: number; expires_at?: string | null }> {
    return this.request(`${this.projectPath(projectId)}/members/all/${userId}`);
  }

  setCommitStatus(
    projectId: string | number,
    sha: string,
    status: {
      state: "pending" | "running" | "success" | "failed" | "skipped";
      name: string;
      description: string;
      target_url?: string;
    },
  ): Promise<unknown> {
    return this.request(
      `${this.projectPath(projectId)}/statuses/${encodeURIComponent(sha)}`,
      { method: "POST", json: status },
    );
  }

  listAwards(
    projectId: string | number,
    mrIid: number,
  ): Promise<GitlabAward[]> {
    return this.pages(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/award_emoji`,
    );
  }

  addAward(
    projectId: string | number,
    mrIid: number,
    name: "eyes" | "tada" | "confused",
  ): Promise<GitlabAward> {
    return this.request(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/award_emoji`,
      { method: "POST", json: { name } },
    );
  }

  removeAward(
    projectId: string | number,
    mrIid: number,
    id: number,
  ): Promise<void> {
    return this.request(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/award_emoji/${id}`,
      { method: "DELETE" },
    );
  }

  getBranch(projectId: string | number, branch: string): Promise<GitlabBranch> {
    return this.request(
      `${this.projectPath(projectId)}/repository/branches/${encodeURIComponent(branch)}`,
    );
  }

  getFileInfo(
    projectId: string | number,
    filePath: string,
    ref: string,
  ): Promise<{
    content: string;
    encoding: string;
    last_commit_id: string;
    execute_filemode: boolean;
  }> {
    return this.request(
      `${this.projectPath(projectId)}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`,
    );
  }

  getTree(
    projectId: string | number,
    directory: string,
    ref: string,
  ): Promise<Array<{ path: string; mode: string; type: string }>> {
    return this.pages(
      `${this.projectPath(projectId)}/repository/tree?path=${encodeURIComponent(directory)}&ref=${encodeURIComponent(ref)}`,
    );
  }

  deleteBranch(projectId: string | number, branch: string): Promise<void> {
    return this.request(
      `${this.projectPath(projectId)}/repository/branches/${encodeURIComponent(branch)}`,
      { method: "DELETE" },
    );
  }

  createCommit(
    projectId: string | number,
    input: {
      branch: string;
      start_sha?: string;
      commit_message: string;
      actions: GitlabCommitAction[];
    },
  ): Promise<{ id: string; web_url: string }> {
    return this.request(`${this.projectPath(projectId)}/repository/commits`, {
      method: "POST",
      json: input,
    });
  }

  createMr(
    projectId: string | number,
    input: {
      source_branch: string;
      target_branch: string;
      title: string;
      description: string;
    },
  ): Promise<GitlabMr> {
    return this.request(`${this.projectPath(projectId)}/merge_requests`, {
      method: "POST",
      json: input,
    });
  }
}

export function createGitlabClient(
  token: string,
  baseUrl?: string,
): GitlabClient {
  return new GitlabClient(token, baseUrl);
}
