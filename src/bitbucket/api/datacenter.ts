import {
  BitbucketApiError,
  BitbucketHttp,
  type BitbucketHttpOptions,
} from "./http";
import type {
  BitbucketBuildStatus,
  BitbucketClient,
  BitbucketComment,
  BitbucketDiff,
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
  truncated?: boolean;
  hunks?: Array<{
    truncated?: boolean;
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
    authorId: c.author?.name ?? null,
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
  // DC inline comments anchor to exactly one line.
  readonly supportsMultiLineComments = false;
  readonly pinsAnchorsToCommits = true;
  private readonly http: BitbucketHttp;
  private readonly serverUrl: string;
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
    this.serverUrl = server;
    this.repoUrl = `${server}/rest/api/1.0/projects/${encodeURIComponent(options.projectKey)}/repos/${encodeURIComponent(options.repoSlug)}`;
    this.prUrl = `${this.repoUrl}/pull-requests/${options.prId}`;
  }

  /** The username behind the credentials, from the applinks whoami servlet. */
  async getCurrentUserId(): Promise<string | null> {
    try {
      const name = (
        await this.http.text(
          `${this.serverUrl}/plugins/servlet/applinks/whoami`,
        )
      ).trim();
      return name || null;
    } catch {
      return null;
    }
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
      sourceBranch: pr.fromRef?.displayId ?? "",
      targetBranch: pr.toRef?.displayId ?? "",
      headSha: pr.fromRef?.latestCommit ?? null,
      baseSha: pr.toRef?.latestCommit ?? null,
      webUrl: pr.links?.self?.[0]?.href ?? null,
    };
  }

  /**
   * The server caps diff size (`page.max.diff.lines` and friends) and marks
   * what it cut with `truncated` at the top level, per file, or per hunk.
   */
  async getDiff(): Promise<BitbucketDiff> {
    const data = await this.http.json<{
      diffs?: DcDiff[];
      truncated?: boolean;
    }>(`${this.prUrl}/diff?contextLines=3&withComments=false`);
    const diffs = data.diffs ?? [];
    const truncated =
      data.truncated === true ||
      diffs.some(
        (d) => d.truncated === true || (d.hunks ?? []).some((h) => h.truncated),
      );
    return { text: dcDiffToUnified(diffs), truncated };
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

  async deleteComment(commentId: number): Promise<void> {
    const url = `${this.prUrl}/comments/${commentId}`;
    const current = await this.http.json<DcComment>(url);
    await this.http.json(`${url}?version=${current.version}`, {
      method: "DELETE",
    });
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
    // For the effective diff, "from" is the target branch and "to" the
    // source branch, matching what the web UI sends.
    if (anchor.diffRefs) {
      dcAnchor.fromHash = anchor.diffRefs.fromHash;
      dcAnchor.toHash = anchor.diffRefs.toHash;
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
    const url = `${this.repoUrl}/commits/${encodeURIComponent(commitSha)}/builds`;
    const base = {
      key: status.key,
      state: status.state,
      name: status.name,
      url: status.url,
      description: status.description,
    };
    // Required builds merge checks match a status by `parent` (and `ref`),
    // not by `key`, and Atlassian documents no fallback from one to the other.
    const withParent = {
      ...base,
      parent: status.key,
      ...(status.ref ? { ref: status.ref } : {}),
    };
    try {
      await this.http.json(url, { method: "POST", json: withParent });
    } catch (error) {
      // Servers that predate Required builds (before 7.14) may reject the
      // extra fields; they cannot enforce the check anyway.
      if (!(error instanceof BitbucketApiError) || error.status !== 400) {
        throw error;
      }
      console.warn(
        `Bitbucket rejected the build status with parent/ref (${error.message}); retrying without them.`,
      );
      await this.http.json(url, { method: "POST", json: base });
    }
  }
}
