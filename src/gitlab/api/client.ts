import { GITLAB_API_URL } from "./config";
import type {
  GitlabMr,
  GitlabMrChanges,
  GitlabNote,
  GitlabDiscussion,
  GitlabPosition,
  GitlabUser,
} from "../types";
import {
  redactDeep,
  redactSecrets,
  secretValuesFromEnv,
} from "../../utils/redact-credentials";

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
      throw new GitlabApiError(
        response.status,
        response.statusText || "Request failed",
        parsed,
        secrets,
      );
    }

    if (response.status === 204) {
      return undefined as unknown as T;
    }

    return (await response.json()) as T;
  }

  private projectPath(projectId: string | number): string {
    return `/projects/${encodeURIComponent(String(projectId))}`;
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
    return this.request<GitlabNote[]>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/notes?per_page=100`,
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
}

export function createGitlabClient(
  token: string,
  baseUrl?: string,
): GitlabClient {
  return new GitlabClient(token, baseUrl);
}
