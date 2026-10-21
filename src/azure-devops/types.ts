/**
 * Shapes of the Azure DevOps Git REST API (api-version 6.0) that the review
 * runtime reads or sends. Only the fields the runtime uses are typed; the
 * real responses carry many more.
 */

export type AdoIdentityRef = {
  id: string;
  displayName?: string;
  uniqueName?: string;
};

export type AdoCommitRef = { commitId: string };

export type AdoPullRequestStatus =
  | "notSet"
  | "active"
  | "abandoned"
  | "completed"
  | "all";

export type AdoPullRequest = {
  pullRequestId: number;
  status: AdoPullRequestStatus;
  isDraft?: boolean;
  title: string;
  description?: string;
  sourceRefName: string;
  targetRefName: string;
  createdBy?: AdoIdentityRef;
  lastMergeSourceCommit?: AdoCommitRef;
  lastMergeTargetCommit?: AdoCommitRef;
  repository?: {
    id: string;
    name: string;
    project?: { id: string; name: string };
  };
};

export type AdoIteration = {
  id: number;
  sourceRefCommit: AdoCommitRef;
  targetRefCommit: AdoCommitRef;
  commonRefCommit?: AdoCommitRef;
};

export type AdoIterationChange = {
  changeTrackingId: number;
  changeId?: number;
  changeType?: string;
  item: { path: string; objectId?: string };
  originalPath?: string;
};

export type AdoIterationChangesPage = {
  changeEntries: AdoIterationChange[];
  nextSkip?: number;
  nextTop?: number;
};

export type AdoCommentType = "unknown" | "text" | "codeChange" | "system";

export type AdoComment = {
  id: number;
  parentCommentId?: number;
  author?: AdoIdentityRef;
  content?: string;
  commentType?: AdoCommentType;
  isDeleted?: boolean;
  publishedDate?: string;
  lastUpdatedDate?: string;
};

export type AdoFilePosition = { line: number; offset: number };

export type AdoThreadContext = {
  filePath: string;
  rightFileStart?: AdoFilePosition;
  rightFileEnd?: AdoFilePosition;
  leftFileStart?: AdoFilePosition;
  leftFileEnd?: AdoFilePosition;
};

export type AdoPullRequestThreadContext = {
  changeTrackingId?: number;
  iterationContext?: {
    firstComparingIteration: number;
    secondComparingIteration: number;
  };
};

export type AdoThreadStatus =
  | "unknown"
  | "active"
  | "fixed"
  | "wontFix"
  | "closed"
  | "byDesign"
  | "pending";

/** A PropertiesCollection entry as serialized by Azure DevOps. */
export type AdoProperty = { $type?: string; $value: unknown };

export type AdoThread = {
  id: number;
  status?: AdoThreadStatus;
  isDeleted?: boolean;
  threadContext?: AdoThreadContext | null;
  pullRequestThreadContext?: AdoPullRequestThreadContext | null;
  comments: AdoComment[];
  properties?: Record<string, AdoProperty> | null;
};

export type AdoCreateThreadRequest = {
  comments: Array<{
    parentCommentId: 0;
    content: string;
    commentType: "text";
  }>;
  status?: AdoThreadStatus;
  threadContext?: AdoThreadContext;
  pullRequestThreadContext?: AdoPullRequestThreadContext;
  properties?: Record<string, AdoProperty>;
};

export type AdoListResponse<T> = { value: T[]; count?: number };
