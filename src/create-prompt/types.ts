import type { GitHubContext } from "../github/context";

export type CommonFields = {
  repository: string;
  droidCommentId?: string;
  triggerPhrase: string;
  triggerUsername?: string;
  droidBranch?: string;
};

type PullRequestReviewCommentEvent = {
  eventName: "pull_request_review_comment";
  isPR: true;
  prNumber: string;
  commentId?: string;
  commentBody: string;
  droidBranch?: string;
  baseBranch?: string;
};

type PullRequestReviewEvent = {
  eventName: "pull_request_review";
  isPR: true;
  prNumber: string;
  commentBody: string;
  droidBranch?: string;
  baseBranch?: string;
};

type IssueCommentEvent = {
  eventName: "issue_comment";
  commentId: string;
  issueNumber: string;
  isPR: false;
  baseBranch: string;
  droidBranch: string;
  commentBody: string;
};

type PullRequestCommentEvent = {
  eventName: "issue_comment";
  commentId: string;
  prNumber: string;
  isPR: true;
  commentBody: string;
  droidBranch?: string;
  baseBranch?: string;
};

type IssueOpenedEvent = {
  eventName: "issues";
  eventAction: "opened";
  isPR: false;
  issueNumber: string;
  baseBranch: string;
  droidBranch: string;
};

type IssueAssignedEvent = {
  eventName: "issues";
  eventAction: "assigned";
  isPR: false;
  issueNumber: string;
  baseBranch: string;
  droidBranch: string;
  assigneeTrigger?: string;
};

type IssueLabeledEvent = {
  eventName: "issues";
  eventAction: "labeled";
  isPR: false;
  issueNumber: string;
  baseBranch: string;
  droidBranch: string;
  labelTrigger: string;
};

type PullRequestBaseEvent = {
  eventAction?: string;
  isPR: true;
  prNumber: string;
  droidBranch?: string;
  baseBranch?: string;
};

type PullRequestEvent = PullRequestBaseEvent & {
  eventName: "pull_request";
};

type PullRequestTargetEvent = PullRequestBaseEvent & {
  eventName: "pull_request_target";
};

export type EventData =
  | PullRequestReviewCommentEvent
  | PullRequestReviewEvent
  | PullRequestCommentEvent
  | IssueCommentEvent
  | IssueOpenedEvent
  | IssueAssignedEvent
  | IssueLabeledEvent
  | PullRequestEvent
  | PullRequestTargetEvent;

export type PreparedContext = CommonFields & {
  eventData: EventData;
  githubContext?: GitHubContext;
  prBranchData?: {
    headRefName: string;
    headRefOid: string;
  };
};
