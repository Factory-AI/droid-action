import {
  BitbucketApiError,
  BitbucketHttp,
  type BitbucketHttpOptions,
} from "./http";
import type {
  BitbucketBuildStatus,
  BitbucketClient,
  BitbucketComment,
  BitbucketInlineAnchor,
  BitbucketPullRequest,
} from "../types";

type DcPage<T> = {
  values: T[];
  isLastPage: boolean;
  nextPageStart?: number;
};

export type DcPullRequest = {
  id: number;
  version?: number;
  title: string;
  description?: string;
  state: string;
  draft?: boolean;
  author?: { user?: { name?: string; displayName?: string } };
  fromRef: { displayId: string; latestCommit?: string };
  toRef: { displayId: string; latestCommit?: string };
  links?: { self?: Array<{ href: string }> };
};

export type DcComment = {
  id: number;
  version: number;
  text: string;
  createdDate?: number;
  author?: { name?: string; displayName?: string };
  anchor?: { path?: string; line?: number };
  comments?: DcComment[];
};

type DcActivity = {
  action: string;
  commentAction?: string;
  comment?: DcComment;
  commentAnchor?: { path?: string; line?: number };
};

export type DcDiffLine = { source: number; destination: number; line: string };
export type DcDiff = {
  source?: { toString: string } | null;
  destination?: { toString: string } | null;
  binary?: boolean;
  hunks?: Array<{
    sourceLine: number;
    sourceSpan: number;
    destinationLine: number;
    destinationSpan: number;
    segments: Array<{
      type: "ADDED" | "REMOVED" | "CONTEXT";
      lines: DcDiffLine[];
    }>;
  }>;
};

/**
 * Render Data Center's structured diff JSON as a unified `git diff`, the
 * format the review prompts and the shared line index consume. The JSON
 * endpoint exists on every DC/Server version, unlike the raw `.diff` one.
 */
export function dcDiffToUnified(diffs: DcDiff[]): string {
  const out: string[] = [];
  for (const d of diffs) {
    const src = d.source?.toString ?? null;
    const dst = d.destination?.toString ?? null;
    const a = src ?? dst ?? "";
    const b = dst ?? src ?? "";
    out.push(`diff --git a/${a} b/${b}`);
    if (d.binary) {
      out.push(
        `Binary files ${src ? `a/${src}` : "/dev/null"} and ${dst ? `b/${dst}` : "/dev/null"} differ`,
      );
      continue;
    }
    out.push(`--- ${src ? `a/${src}` : "/dev/null"}`);
    out.push(`+++ ${dst ? `b/${dst}` : "/dev/null"}`);
    for (const h of d.hunks ?? []) {
      out.push(
        `@@ -${h.sourceLine},${h.sourceSpan} +${h.destinationLine},${h.destinationSpan} @@`,
      );
      for (const seg of h.segments ?? []) {
        const prefix =
          seg.type === "ADDED" ? "+" : seg.type === "REMOVED" ? "-" : " ";
        for (const l of seg.lines ?? []) out.push(`${prefix}${l.line}`);
      }
    }
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

function toComment(
  c: DcComment,
  anchor: { path?: string; line?: number } | undefined,
  parentId: number | null,
): BitbucketComment {
  return {
    id: c.id,
    body: c.text ?? "",
    author: c.author?.name ?? c.author?.displayName ?? null,
    createdAt: c.createdDate ? new Date(c.createdDate).toISOString() : null,
    path: anchor?.path ?? c.anchor?.path ?? null,
    line: anchor?.line ?? c.anchor?.line ?? null,
    parentId,
  };
}

/**
 * Bitbucket Data Center / Server REST 1.0 client bound to one pull request.
 * https://developer.atlassian.com/server/bitbucket/rest/
 */
export class BitbucketDataCenterClient implements BitbucketClient {
  readonly variant = "datacenter" as const;
  // DC inline comments anchor to exactly one line.
  readonly supportsMultiLineComments = false;
  private readonly http: BitbucketHttp;
  private readonly repoUrl: string;
  private readonly prUrl: string;

  constructor(
    options: BitbucketHttpOptions & {
      serverUrl: string;
      projectKey: string;
      repoSlug: string;
      prId: number;
    },
  ) {
    this.http = new BitbucketHttp(options);
    const server = options.serverUrl.replace(/\/+$/, "");
    this.repoUrl = `${server}/rest/api/1.0/projects/${encodeURIComponent(options.projectKey)}/repos/${encodeURIComponent(options.repoSlug)}`;
    this.prUrl = `${this.repoUrl}/pull-requests/${options.prId}`;
  }

  private async paged<T>(url: string): Promise<T[]> {
    const out: T[] = [];
    const sep = url.includes("?") ? "&" : "?";
    let start = 0;
    for (let page = 0; page < 1000; page++) {
      const data = await this.http.json<DcPage<T>>(
        `${url}${sep}start=${start}&limit=100`,
      );
      out.push(...(data.values ?? []));
      if (data.isLastPage !== false || data.nextPageStart === undefined) break;
      start = data.nextPageStart;
    }
    return out;
  }

  async getPullRequest(): Promise<BitbucketPullRequest> {
    const pr = await this.http.json<DcPullRequest>(this.prUrl);
    return {
      id: pr.id,
      title: pr.title ?? "",
      description: pr.description ?? "",
      draft: pr.draft === true,
      state: pr.state,
      sourceBranch: pr.fromRef?.displayId ?? "",
      targetBranch: pr.toRef?.displayId ?? "",
      headSha: pr.fromRef?.latestCommit ?? null,
      authorName: pr.author?.user?.name ?? pr.author?.user?.displayName ?? null,
      webUrl: pr.links?.self?.[0]?.href ?? null,
    };
  }

  async getDiff(): Promise<string> {
    const data = await this.http.json<{ diffs?: DcDiff[] }>(
      `${this.prUrl}/diff?contextLines=3&withComments=false`,
    );
    return dcDiffToUnified(data.diffs ?? []);
  }

  /** Comments arrive through the activity feed; replies are nested. */
  async listComments(): Promise<BitbucketComment[]> {
    const activities = await this.paged<DcActivity>(`${this.prUrl}/activities`);
    const out: BitbucketComment[] = [];
    const walk = (
      c: DcComment,
      anchor: DcActivity["commentAnchor"],
      parentId: number | null,
    ) => {
      out.push(toComment(c, anchor, parentId));
      for (const reply of c.comments ?? []) walk(reply, anchor, c.id);
    };
    for (const a of activities) {
      if (
        a.action === "COMMENTED" &&
        a.commentAction === "ADDED" &&
        a.comment
      ) {
        walk(a.comment, a.commentAnchor, null);
      }
    }
    return out;
  }

  async createComment(body: string): Promise<BitbucketComment> {
    const created = await this.http.json<DcComment>(`${this.prUrl}/comments`, {
      method: "POST",
      json: { text: body },
    });
    return toComment(created, undefined, null);
  }

  /**
   * DC rejects an edit whose `version` is stale with 409, so read the
   * current version first and retry once if someone edited in between.
   */
  async updateComment(
    commentId: number,
    body: string,
  ): Promise<BitbucketComment> {
    const url = `${this.prUrl}/comments/${commentId}`;
    for (let attempt = 0; ; attempt++) {
      const current = await this.http.json<DcComment>(url);
      try {
        const updated = await this.http.json<DcComment>(url, {
          method: "PUT",
          json: { text: body, version: current.version },
        });
        return toComment(updated, undefined, null);
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof BitbucketApiError &&
          error.status === 409
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  async createInlineComment(
    body: string,
    anchor: BitbucketInlineAnchor,
  ): Promise<BitbucketComment> {
    const dcAnchor: Record<string, unknown> = {
      diffType: "EFFECTIVE",
      path: anchor.path,
      line: anchor.line,
      lineType: anchor.lineType,
      fileType: anchor.lineType === "REMOVED" ? "FROM" : "TO",
    };
    if (anchor.oldPath && anchor.oldPath !== anchor.path) {
      dcAnchor.srcPath = anchor.oldPath;
    }
    const created = await this.http.json<DcComment>(`${this.prUrl}/comments`, {
      method: "POST",
      json: { text: body, anchor: dcAnchor },
    });
    return toComment(created, undefined, null);
  }

  /** Build status API introduced in Bitbucket Server 7.4. */
  async setBuildStatus(
    commitSha: string,
    status: BitbucketBuildStatus,
  ): Promise<void> {
    await this.http.json(
      `${this.repoUrl}/commits/${encodeURIComponent(commitSha)}/builds`,
      { method: "POST", json: status },
    );
  }
}
