import { GITHUB_SERVER_URL } from "../../api/config";
import { sanitizeContent } from "../../utils/sanitizer";

export type PrValidationSource = "review";

export function createPrValidationMarker(source: PrValidationSource): string {
  return `<!-- factory-pr-validation: source=${source} -->`;
}

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

export type CommentType = "default" | "security" | "review_and_security";

export function appendPrValidationMarker(
  content: string,
  source: PrValidationSource,
): string {
  const marker = createPrValidationMarker(source);
  if (content.includes(marker)) {
    return content;
  }
  const trimmedContent = content.trimEnd();
  return trimmedContent ? `${trimmedContent}\n\n${marker}` : marker;
}

export function prepareDroidCommentBody(
  content: string,
  prValidationSource?: PrValidationSource,
): string {
  const sanitized = sanitizeContent(content);
  return prValidationSource
    ? appendPrValidationMarker(sanitized, prValidationSource)
    : sanitized;
}

export function createCommentBody(
  jobRunLink: string,
  branchLink: string = "",
  type: CommentType = "default",
  prValidationSource?: PrValidationSource,
): string {
  let message: string;
  if (type === "review_and_security") {
    message = "Droid is reviewing code and running a security check…";
  } else if (type === "security") {
    message = "Droid is running a security check…";
  } else {
    message = "Droid is working…";
  }

  const body = `${message}

${jobRunLink}${branchLink}`;

  return prValidationSource
    ? appendPrValidationMarker(body, prValidationSource)
    : body;
}
