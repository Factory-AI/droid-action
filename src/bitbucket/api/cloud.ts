import { BitbucketHttp, type BitbucketHttpOptions } from "./http";
import type {
  BitbucketBuildStatus,
  BitbucketClient,
  BitbucketComment,
  BitbucketInlineAnchor,
  BitbucketPullRequest,
} from "../types";

export const BITBUCKET_CLOUD_API_URL = "https://api.bitbucket.org/2.0";

type CloudPage<T> = { values: T[]; next?: string };

export type CloudPullRequest = {
  id: number;
  title: string;
  description?: string | null;
  state: string;
  draft?: boolean;
  author?: { display_name?: string; nickname?: string } | null;
  source: { branch: { name: string }; commit?: { hash: string } | null };
  destination: { branch: { name: string }; commit?: { hash: string } | null };
  links?: { html?: { href: string } };
};

export type CloudComment = {
  id: number;
  content: { raw: string };
  deleted?: boolean;
  created_on?: string;
  user?: { display_name?: string; nickname?: string } | null;
  inline?: { path: string; from?: number | null; to?: number | null };
  parent?: { id: number };
};

function toComment(c: CloudComment): BitbucketComment {
  return {
    id: c.id,
    body: c.content?.raw ?? "",
    author: c.user?.nickname ?? c.user?.display_name ?? null,
    createdAt: c.created_on ?? null,
    path: c.inline?.path ?? null,
    line: c.inline?.to ?? c.inline?.from ?? null,
    parentId: c.parent?.id ?? null,
  };
}

/**
 * Bitbucket Cloud REST 2.0 client bound to one pull request.
 * https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/
 */
export class BitbucketCloudClient implements BitbucketClient {
  readonly variant = "cloud" as const;
  readonly supportsMultiLineComments = true;
  private readonly http: BitbucketHttp;
  private readonly repoUrl: string;
  private readonly prUrl: string;

  constructor(
    options: BitbucketHttpOptions & {
      workspace: string;
      repoSlug: string;
      prId: number;
      apiUrl?: string;
    },
  ) {
    this.http = new BitbucketHttp(options);
    const base = (options.apiUrl || BITBUCKET_CLOUD_API_URL).replace(
      /\/+$/,
      "",
    );
    this.repoUrl = `${base}/repositories/${encodeURIComponent(options.workspace)}/${encodeURIComponent(options.repoSlug)}`;
    this.prUrl = `${this.repoUrl}/pullrequests/${options.prId}`;
  }

  async getPullRequest(): Promise<BitbucketPullRequest> {
    const pr = await this.http.json<CloudPullRequest>(this.prUrl);
    return {
      id: pr.id,
      title: pr.title ?? "",
      description: pr.description ?? "",
      draft: pr.draft === true,
      state: pr.state,
      sourceBranch: pr.source?.branch?.name ?? "",
      targetBranch: pr.destination?.branch?.name ?? "",
      headSha: pr.source?.commit?.hash ?? null,
      authorName: pr.author?.nickname ?? pr.author?.display_name ?? null,
      webUrl: pr.links?.html?.href ?? null,
    };
  }

  /** The endpoint answers with a 302 to the diff resource, which fetch follows. */
  getDiff(): Promise<string> {
    return this.http.text(`${this.prUrl}/diff`);
  }

  async listComments(): Promise<BitbucketComment[]> {
    const out: BitbucketComment[] = [];
    let url: string | undefined = `${this.prUrl}/comments?pagelen=100`;
    // `next` is an absolute URL; a page cap guards against a server that
    // keeps handing back the same link.
    for (let page = 0; url && page < 100; page++) {
      const data: CloudPage<CloudComment> =
        await this.http.json<CloudPage<CloudComment>>(url);
      for (const c of data.values ?? []) {
        if (!c.deleted) out.push(toComment(c));
      }
      url = data.next;
    }
    return out;
  }

  async createComment(body: string): Promise<BitbucketComment> {
    const created = await this.http.json<CloudComment>(
      `${this.prUrl}/comments`,
      { method: "POST", json: { content: { raw: body } } },
    );
    return toComment(created);
  }

  async updateComment(
    commentId: number,
    body: string,
  ): Promise<BitbucketComment> {
    const updated = await this.http.json<CloudComment>(
      `${this.prUrl}/comments/${commentId}`,
      { method: "PUT", json: { content: { raw: body } } },
    );
    return toComment(updated);
  }

  /**
   * `to` addresses the new file (added and context lines), `from` the old
   * file (removed lines). `start_to`/`start_from` make it a range.
   */
  async createInlineComment(
    body: string,
    anchor: BitbucketInlineAnchor,
  ): Promise<BitbucketComment> {
    const inline: Record<string, unknown> = { path: anchor.path };
    if (anchor.lineType === "REMOVED") {
      inline.from = anchor.line;
      if (anchor.startLine !== null) inline.start_from = anchor.startLine;
    } else {
      inline.to = anchor.line;
      if (anchor.startLine !== null) inline.start_to = anchor.startLine;
    }
    const created = await this.http.json<CloudComment>(
      `${this.prUrl}/comments`,
      { method: "POST", json: { content: { raw: body }, inline } },
    );
    return toComment(created);
  }

  async setBuildStatus(
    commitSha: string,
    status: BitbucketBuildStatus,
  ): Promise<void> {
    await this.http.json(
      `${this.repoUrl}/commit/${encodeURIComponent(commitSha)}/statuses/build`,
      { method: "POST", json: status },
    );
  }
}
