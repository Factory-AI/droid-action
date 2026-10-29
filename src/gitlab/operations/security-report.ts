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
  return report.web_url;
}
