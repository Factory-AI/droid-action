import { GITHUB_SERVER_URL } from "../../api/config";
import { sanitizeContent } from "../../utils/sanitizer";
import {
  DroidRunType,
  parsePrValidationRunType,
  type PrValidationRunType,
} from "../../../run-type";

export type PrCommentKind = "issue-comment" | "inline-comment";

// A shared tracking comment can cover more than one execution.
export const COMBINED_REVIEW_COMMENT_RUN_TYPE = "droid-review-and-security";
export type PrCommentRunType =
  | PrValidationRunType
  | typeof COMBINED_REVIEW_COMMENT_RUN_TYPE;

export function mergePrCommentRunTypes(
  existing: PrCommentRunType | undefined,
  current: PrCommentRunType | undefined,
): PrCommentRunType | undefined {
  if (
    existing === COMBINED_REVIEW_COMMENT_RUN_TYPE ||
    current === COMBINED_REVIEW_COMMENT_RUN_TYPE
  ) {
    return COMBINED_REVIEW_COMMENT_RUN_TYPE;
  }
  const isCodeReview = (value: PrCommentRunType | undefined) =>
    value === DroidRunType.Review || value === DroidRunType.Default;
  if (
    (isCodeReview(existing) && current === DroidRunType.SecurityReview) ||
    (existing === DroidRunType.SecurityReview && isCodeReview(current))
  ) {
    return COMBINED_REVIEW_COMMENT_RUN_TYPE;
  }
  return current ?? existing;
}

export function readPrCommentRunType(
  body: string,
  kind: PrCommentKind,
): PrCommentRunType | undefined {
  const match = body.match(
    new RegExp(`(?:^|\\n)<!-- factory-pr-${kind}: run-type=([a-z-]+) -->\\s*$`),
  );
  const value = match?.[1];
  return value === COMBINED_REVIEW_COMMENT_RUN_TYPE
    ? value
    : parsePrValidationRunType(value);
}

export function parsePrCommentKind(
  value: string | undefined,
): PrCommentKind | undefined {
  return value === "issue-comment" || value === "inline-comment"
    ? value
    : undefined;
}

export function createPrCommentMarker(
  kind: PrCommentKind,
  runType: PrCommentRunType,
): string {
  return `<!-- factory-pr-${kind}: run-type=${runType} -->`;
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

export function appendPrCommentMarker(
  content: string,
  kind: PrCommentKind,
  runType: PrCommentRunType,
): string {
  const marker = createPrCommentMarker(kind, runType);
  if (content.includes(marker)) {
    return content;
  }
  const trimmedContent = content.trimEnd();
  return trimmedContent ? `${trimmedContent}\n\n${marker}` : marker;
}

export function prepareDroidCommentBody(
  content: string,
  prValidationRunType?: PrCommentRunType,
  kind: PrCommentKind = "issue-comment",
): string {
  const sanitized = sanitizeContent(content);
  return prValidationRunType
    ? appendPrCommentMarker(sanitized, kind, prValidationRunType)
    : sanitized;
}

export function prepareDroidTrackingCommentBody(
  content: string,
  currentBody: string,
  runType?: PrCommentRunType,
  kind: PrCommentKind = "issue-comment",
): string {
  // Only the stored tracking comment contributes prior classification, never
  // markers in the model-provided replacement body.
  const mergedRunType = mergePrCommentRunTypes(
    readPrCommentRunType(currentBody, kind),
    runType,
  );
  return prepareDroidCommentBody(content, mergedRunType, kind);
}

export function createCommentBody(
  jobRunLink: string,
  branchLink: string = "",
  type: CommentType = "default",
  prValidationRunType?: PrValidationRunType,
  kind: PrCommentKind = "issue-comment",
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

  return prValidationRunType
    ? appendPrCommentMarker(
        body,
        kind,
        type === "review_and_security"
          ? COMBINED_REVIEW_COMMENT_RUN_TYPE
          : prValidationRunType,
      )
    : body;
}
