/**
 * Platform-neutral shapes the Bitbucket runtime works with. Bitbucket Cloud
 * (api.bitbucket.org/2.0) and Bitbucket Data Center (/rest/api/1.0) return
 * very different JSON, so each client maps its responses onto these.
 */

export type BitbucketVariant = "cloud" | "datacenter";

export type BitbucketPullRequest = {
  id: number;
  title: string;
  description: string;
  /** Cloud `draft`; DC 8.18+ `draft`. False when the server has no drafts. */
  draft: boolean;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  /** Source branch head. Cloud returns a 12-character abbreviation. */
  headSha: string | null;
  authorName: string | null;
  webUrl: string | null;
};

export type BitbucketComment = {
  id: number;
  body: string;
  author: string | null;
  createdAt: string | null;
  /** Inline location, when the comment is anchored to the diff. */
  path: string | null;
  line: number | null;
  /** Parent comment id for replies. */
  parentId: number | null;
};

export type BitbucketLineType = "ADDED" | "REMOVED" | "CONTEXT";

/**
 * Where an inline comment goes. `line` is the new-file line for ADDED and
 * CONTEXT, and the old-file line for REMOVED. For CONTEXT, `oldLine` is the
 * paired old-file line when known.
 */
export type BitbucketInlineAnchor = {
  path: string;
  oldPath: string | null;
  line: number;
  lineType: BitbucketLineType;
  oldLine: number | null;
  /** Start of a multi-line span on the same side, or null. */
  startLine: number | null;
};

export type BitbucketBuildState = "INPROGRESS" | "SUCCESSFUL" | "FAILED";

export type BitbucketBuildStatus = {
  key: string;
  state: BitbucketBuildState;
  name: string;
  url: string;
  description?: string;
};

export interface BitbucketClient {
  readonly variant: BitbucketVariant;
  /** Whether inline comments can span several lines. */
  readonly supportsMultiLineComments: boolean;
  getPullRequest(): Promise<BitbucketPullRequest>;
  /** Unified diff (`diff --git` format) of the pull request. */
  getDiff(): Promise<string>;
  /** Every non-deleted comment on the pull request, replies included. */
  listComments(): Promise<BitbucketComment[]>;
  createComment(body: string): Promise<BitbucketComment>;
  updateComment(commentId: number, body: string): Promise<BitbucketComment>;
  createInlineComment(
    body: string,
    anchor: BitbucketInlineAnchor,
  ): Promise<BitbucketComment>;
  setBuildStatus(
    commitSha: string,
    status: BitbucketBuildStatus,
  ): Promise<void>;
}
