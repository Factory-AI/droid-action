import { GITHUB_SERVER_URL } from "../../api/config";

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

export function createCommentBody(
  jobRunLink: string,
  branchLink: string = "",
  type: CommentType = "default",
): string {
  let message: string;
  if (type === "review_and_security") {
    message = "Droid is reviewing code and running a security check…";
  } else if (type === "security") {
    message = "Droid is running a security check…";
  } else {
    message = "Droid is working…";
  }

  return `${message}

${jobRunLink}${branchLink}`;
}
