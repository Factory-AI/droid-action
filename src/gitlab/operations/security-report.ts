import { randomUUID } from "node:crypto";
import { parseDroidCommand } from "../../core/review/triggers/parse-command";
import {
  renderSecurityReport,
  type ReviewRenderInput,
} from "../../core/review/render";
import { assertGitlabFixRef } from "./commands";
import type { GitlabClient } from "../api/client";
import type { GitlabMr } from "../types";
import { hasGitlabWriteAccess, isMissingFile } from "./review-ux";
import { record } from "../../core/review/validated/finding";

/** Report publishing is authorized again from the actual trigger note. */
export async function publishGitlabSecurityReport(
  client: GitlabClient,
  projectId: string | number,
  mr: GitlabMr,
  noteId: number,
  input: ReviewRenderInput,
): Promise<string> {
  const [note, user] = await Promise.all([
    client.getNote(projectId, mr.iid, noteId),
    client.getCurrentUser(),
  ]);
  if (parseDroidCommand(note.body)?.command !== "security-full")
    throw new Error(
      "Full security report requires an explicit @droid security --full command",
    );
  const sourceProject = mr.source_project_id;
  if (!sourceProject)
    throw new Error("Cannot verify the security report destination project");
  const [actor, token, project, branch] = await Promise.all([
    client.getMember(sourceProject, note.author.id),
    client.getMember(sourceProject, user.id),
    client.getProject(sourceProject),
    client.getBranch(sourceProject, mr.source_branch),
  ]);
  if (!hasGitlabWriteAccess(actor) || !hasGitlabWriteAccess(token))
    throw new Error(
      "Security report MR creation requires verified actor and token write permission in the source project",
    );
  assertGitlabFixRef(mr.source_branch, mr.diff_refs.head_sha);
  if (
    mr.source_branch === project.default_branch ||
    branch.commit.id !== mr.diff_refs.head_sha
  )
    throw new Error(
      "Security report source branch is the default branch or changed during the audit",
    );
  const marker = `<!-- droid-security-report:v1 note=${note.id} -->`;
  const previous = (await client.listNotes(projectId, mr.iid)).find(
    (entry) =>
      entry.author.id === user.id && entry.body.startsWith(`${marker}\n`),
  );
  if (previous) {
    let receipt: Record<string, unknown> | null = null;
    try {
      receipt = record(JSON.parse(previous.body.split("\n")[1] ?? ""));
    } catch {
      // A malformed/pending receipt is not permission to publish a duplicate.
    }
    const prefix = `${project.web_url}/-/merge_requests/`;
    if (
      receipt?.status === "complete" &&
      typeof receipt.url === "string" &&
      receipt.url.startsWith(prefix) &&
      /^[1-9]\d*$/.test(receipt.url.slice(prefix.length))
    )
      return receipt.url;
    throw new Error(
      "Security report publication already started for this note. Inspect its report branch before issuing a new command; this retry will not publish a duplicate.",
    );
  }
  const filePath = `.factory/security/reports/security-report-${new Date().toISOString().slice(0, 10)}.md`;
  let exists = false;
  try {
    await client.getFileInfo(sourceProject, filePath, mr.diff_refs.head_sha);
    exists = true;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  if (exists) {
    const entry = (
      await client.getTree(
        sourceProject,
        ".factory/security/reports",
        mr.diff_refs.head_sha,
      )
    ).find((item) => item.path === filePath);
    if (
      !entry ||
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode)
    )
      throw new Error("Security report destination must be a regular file");
  }
  const branchName = `droid/security-${mr.iid}-${randomUUID()}`;
  // Normal CI serializes this MR with resource_group. Persist intent before
  // creating anything, so an interrupted publish cannot duplicate on retry.
  const receipt = await client.createNote(
    projectId,
    mr.iid,
    `${marker}\n${JSON.stringify({ status: "pending", head: mr.diff_refs.head_sha, branch: branchName })}\n\nFull security report publication started. If interrupted, inspect branch \`${branchName}\` before issuing a new command.`,
  );
  await client.createCommit(sourceProject, {
    branch: branchName,
    start_sha: mr.diff_refs.head_sha,
    commit_message: `docs: add Droid security audit for !${mr.iid}`,
    actions: [
      {
        action: exists ? "update" : "create",
        file_path: filePath,
        content: Buffer.from(
          renderSecurityReport({ ...input, platform: "gitlab" }),
        ).toString("base64"),
        encoding: "base64",
      },
    ],
  });
  const report = await client.createMr(sourceProject, {
    source_branch: branchName,
    target_branch: mr.source_branch,
    title: `security: full repository audit for !${mr.iid}`,
    description: `${renderSecurityReport({ ...input, platform: "gitlab" })}\n\nReport: \`${filePath}\`\n\nBased on ${mr.web_url}. No approvals or source-branch pushes were made.`,
  });
  await client.updateNote(
    projectId,
    mr.iid,
    receipt.id,
    `${marker}\n${JSON.stringify({ status: "complete", head: mr.diff_refs.head_sha, url: report.web_url })}\n\nFull security report: ${report.web_url}\n\n<!-- droid-command:v1 note=${note.id} -->`,
  );
  return report.web_url;
}
