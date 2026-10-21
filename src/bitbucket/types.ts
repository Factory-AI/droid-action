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
  sourceBranch: string;
  targetBranch: string;
  /** Full SHA of the source branch head. */
  headSha: string | null;
  /**
   * Target branch head. Full on Data Center; Cloud abbreviates it and the
   * Cloud runtime never needs it.
   */
  baseSha: string | null;
  webUrl: string | null;
};

export type BitbucketComment = {
  id: number;
  body: string;
  author: string | null;
  /**
   * Stable id of the author, comparable with `getCurrentUserId()`: the
   * account UUID on Cloud, the username on Data Center.
   */
  authorId: string | null;
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
  /** Start of a multi-line span on the same side, or null. */
  startLine: number | null;
  /**
   * The commits the reviewed diff was computed between. Data Center pins
   * the anchor to them so a push after the review cannot shift it onto
   * different code; Cloud has no equivalent and ignores it.
   */
  diffRefs?: { fromHash: string; toHash: string } | null;
};

export type BitbucketDiff = {
  /** Unified diff (`diff --git` format). */
  text: string;
  /** True when the server cut the diff short (Data Center size limits). */
  truncated: boolean;
};

export type BitbucketBuildState = "INPROGRESS" | "SUCCESSFUL" | "FAILED";

export type BitbucketBuildStatus = {
  key: string;
  state: BitbucketBuildState;
  name: string;
  url: string;
  description?: string;
  /** Full name of the built ref, e.g. `refs/heads/feature`. Data Center only. */
  ref?: string;
};

export interface BitbucketClient {
  /** Whether inline comments can span several lines. */
  readonly supportsMultiLineComments: boolean;
  /**
   * Whether inline anchors can name the commits they were computed against
   * (`BitbucketInlineAnchor.diffRefs`). Without it, an anchor always lands on
   * the pull request's current diff.
   */
  readonly pinsAnchorsToCommits: boolean;
  /**
   * Id of the identity these credentials post as (see
   * `BitbucketComment.authorId`), or null when the server will not say.
   */
  getCurrentUserId(): Promise<string | null>;
  getPullRequest(): Promise<BitbucketPullRequest>;
  getDiff(): Promise<BitbucketDiff>;
  /** Every non-deleted comment on the pull request, replies included. */
  listComments(): Promise<BitbucketComment[]>;
  createComment(body: string): Promise<BitbucketComment>;
  updateComment(commentId: number, body: string): Promise<BitbucketComment>;
  deleteComment(commentId: number): Promise<void>;
  createInlineComment(
    body: string,
    anchor: BitbucketInlineAnchor,
  ): Promise<BitbucketComment>;
  setBuildStatus(
    commitSha: string,
    status: BitbucketBuildStatus,
  ): Promise<void>;
}
