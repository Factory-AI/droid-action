import { GITHUB_SERVER_URL } from "../../api/config";
import { sanitizeContent } from "../../utils/sanitizer";

export const DROID_PR_REVIEW_MARKER = "<!-- factory-pr-review -->";

export function createJobRunLink(
  owner: string,
  repo: string,
  runId: string,
): string {
  const jobRunUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${runId}`;
  return `[View job run](${jobRunUrl})`;
}

export function createBranchLink(
  owner: string,
  repo: string,
  branchName: string,
): string {
  const branchUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/tree/${branchName}`;
  return `\n[View branch](${branchUrl})`;
}

export type CommentType =
  | "default"
  | "review"
  | "security"
  | "security_scan"
  | "review_and_security";

function isReviewCommentType(type: CommentType): boolean {
  return (
    type === "review" || type === "security" || type === "review_and_security"
  );
}

export function appendPrReviewMarker(content: string): string {
  if (content.includes(DROID_PR_REVIEW_MARKER)) {
    return content;
  }
  const trimmedContent = content.trimEnd();
  return trimmedContent
    ? `${trimmedContent}\n\n${DROID_PR_REVIEW_MARKER}`
    : DROID_PR_REVIEW_MARKER;
}

export function prepareDroidCommentBody(
  content: string,
  includePrReviewMarker: boolean,
): string {
  const sanitized = sanitizeContent(content);
  return includePrReviewMarker ? appendPrReviewMarker(sanitized) : sanitized;
}

export function createCommentBody(
  jobRunLink: string,
  branchLink: string = "",
  type: CommentType = "default",
): string {
  let message: string;
  if (type === "review_and_security") {
    message = "Droid is reviewing code and running a security check…";
  } else if (type === "security" || type === "security_scan") {
    message = "Droid is running a security check…";
  } else {
    message = "Droid is working…";
  }

  const body = `${message}

${jobRunLink}${branchLink}`;

  return isReviewCommentType(type) ? appendPrReviewMarker(body) : body;
}
