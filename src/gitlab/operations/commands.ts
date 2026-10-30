import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseDroidCommand,
  type ParsedCommand,
} from "../../core/review/triggers/parse-command";
import {
  assertFixPath,
  chooseFixTarget,
  fixProposalSchema,
  UNTRUSTED_FINDING_PREAMBLE,
} from "../../core/review/fix";
import { updateGeneratedDescription } from "../../core/review/fill";
import { encodeReviewState, type ReviewState } from "../../core/review/markers";
import { fenced, prose } from "../../core/review/render";
import type { ReviewUxConfig } from "../../core/review/config";
import {
  redactSecrets,
  secretValuesFromEnv,
} from "../../utils/redact-credentials";
import type { GitlabClient } from "../api/client";
import { setupGitlabToken } from "../token";
import type { GitlabCommitAction, GitlabMr } from "../types";
import {
  discussionFinding,
  hasGitlabWriteAccess,
  isMissingFile,
  loadReviewMemory,
  reconcileDiscussionState,
  warnCapability,
} from "./review-ux";

export const GITLAB_COMMAND_HELP = `### Droid commands

| Command | Behavior |
| --- | --- |
| \`@droid review\` | Review new changes |
| \`@droid review --full\` | Review the full MR |
| \`@droid review <focus>\` | Focus the review |
| \`@droid security\` / \`@droid review security\` | Security-focused MR review |
| \`@droid fix\` | Fix the finding in this discussion, or all open findings |
| \`@droid resolve\` | Resolve open Droid discussions |
| \`@droid pause\` / \`@droid resume\` | Pause/resume automatic reviews |
| \`@droid fill\` | Update only Droid's marked description block |
| \`@droid <question>\` in a Droid discussion | Answer in this discussion |
| \`@droid help\` | Show this table and effective settings |

GitLab note commands need the authenticated pipeline bridge described in the setup guide. Droid never approves or requests changes.`;

export type CommandExecution = (
  prompt: string,
  mode: "answer" | "fill" | "fix",
) => Promise<string>;

/** File-only model output, with GitLab publishing reserved for trusted code. */
export const executeGitlabCommand: CommandExecution = async (prompt, mode) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "droid-gitlab-command-"),
  );
  const output = path.join(directory, "result.txt");
  const promptPath = path.join(directory, "prompt.txt");
  await fs.writeFile(
    promptPath,
    `${prompt}\n\nWrite your final ${mode === "fix" ? "JSON proposal" : "Markdown answer"} to ${output}. Do not mutate GitLab, git refs, remotes, or commits. That output file is your only deliverable.`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /^(?:GITLAB_TOKEN|OVERRIDE_GITLAB_TOKEN|CI_JOB_TOKEN|CI_REPOSITORY_URL|GITHUB_TOKEN|GH_TOKEN|INPUT_|ACTIONS_|DROID_ARGS|GIT_CONFIG|GIT_ASKPASS|SSH_ASKPASS)/.test(
        key,
      )
    )
      delete env[key];
  const result = spawnSync(
    "droid",
    [
      "exec",
      "-f",
      promptPath,
      "--enabled-tools",
      "Read,Grep,Glob,LS,Execute,Create,Edit,ApplyPatch,Skill",
      "--skip-permissions-unsafe",
    ],
    { env, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(
      "Droid command execution failed; inspect the job log and retry",
    );
  const stat = await fs.lstat(output);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
    throw new Error("Droid command output is not a bounded regular file");
  return fs.readFile(output, "utf8");
};

export type GitlabCommandResult = {
  handled: boolean;
  command?: ParsedCommand;
  security?: boolean;
  securityFull?: boolean;
};

export async function dispatchGitlabCommand(options: {
  client: GitlabClient;
  projectId: string | number;
  mr: GitlabMr;
  config: ReviewUxConfig;
  noteId: number;
  execute?: CommandExecution;
  push?: typeof pushFixCommit;
}): Promise<GitlabCommandResult> {
  const { client, projectId, mr, config } = options;
  const note = await client.getNote(projectId, mr.iid, options.noteId);
  const member = await client.getMember(projectId, note.author.id);
  if (!hasGitlabWriteAccess(member))
    throw new Error(
      "Droid commands require an active GitLab Developer, Maintainer, or Owner",
    );
  const parsed = parseDroidCommand(note.body);
  if (!parsed) return { handled: true };
  const memory = await loadReviewMemory(client, projectId, mr.iid);
  if (note.author.id === memory.user.id) return { handled: true };
  const discussions = await client.listDiscussions(projectId, mr.iid);
  const thread = discussions.find(
    (d) =>
      d.notes.some((n) => n.id === note.id) &&
      discussionFinding(d, memory.user.id),
  );
  const reply = async (body: string) =>
    thread
      ? client.replyToDiscussion(projectId, mr.iid, thread.id, body)
      : client.createNote(projectId, mr.iid, body);
  // A bridge retry must not execute a write twice. Only this token's own
  // response counts; a pasted marker in another user's note is not authority.
  const receipt = `<!-- droid-command:v1 note=${note.id} -->`;
  if (
    (await client.listNotes(projectId, mr.iid)).some(
      (n) =>
        n.author.id === memory.user.id && n.body.split("\n").includes(receipt),
    )
  )
    return { handled: true };
  const respond = (body: string) => reply(`${body}\n\n${receipt}`);
  if (
    parsed.command === "review" ||
    parsed.command === "default" ||
    parsed.command === "security" ||
    parsed.command === "security-full"
  )
    return {
      handled: false,
      command: parsed,
      security:
        parsed.command === "security" || parsed.command === "security-full",
      securityFull: parsed.command === "security-full",
    };
  if (parsed.command === "help" || (parsed.command === "unknown" && !thread)) {
    await respond(
      `${GITLAB_COMMAND_HELP}\n\n<details><summary>Effective settings</summary>\n\n${fenced(JSON.stringify(config, null, 2), "json")}\n</details>`,
    );
    return { handled: true };
  }
  let state: ReviewState = memory.state ?? { head: "", findings: [] };
  state = reconcileDiscussionState(state, discussions, memory.user.id);
  if (parsed.command === "pause" || parsed.command === "resume") {
    state = {
      ...state,
      paused: parsed.command === "pause",
      ...(parsed.command === "resume" ? { autoRunCount: 0 } : {}),
    };
    if (memory.note) {
      // Replace the decoded state as a standalone marker; never alter author text.
      const body = memory.note.body.replace(
        /^<!--\s*droid-review-state:v1\s+\{.*\}\s*-->\s*$/m,
        "",
      );
      await client.updateNote(
        projectId,
        mr.iid,
        memory.note.id,
        `${encodeReviewState(state)}\n${body}`,
      );
    } else
      await client.createNote(
        projectId,
        mr.iid,
        `<!-- droid-review-summary:v1 -->\n${encodeReviewState(state)}`,
      );
    await respond(
      parsed.command === "pause"
        ? "Automatic Droid reviews are paused. Comment `@droid resume` to restart."
        : "Automatic Droid reviews resumed; the automatic-run budget was reset.",
    );
    return { handled: true };
  }
  if (parsed.command === "resolve") {
    let count = 0;
    for (const discussion of discussions) {
      const own = discussionFinding(discussion, memory.user.id);
      if (!own?.note.resolvable || own.note.resolved) continue;
      await client.resolveDiscussion(projectId, mr.iid, discussion.id);
      count++;
    }
    await respond(
      `Resolved ${count} Droid ${count === 1 ? "discussion" : "discussions"}. Dismissed findings will not be raised again.`,
    );
    return { handled: true };
  }
  const execute = options.execute ?? executeGitlabCommand;
  const changes = await client.getMrChanges(projectId, mr.iid);
  const context = `${UNTRUSTED_FINDING_PREAMBLE}\n\nUntrusted MR data:\n${JSON.stringify({ title: mr.title, description: mr.description, head: mr.diff_refs.head_sha, notes: thread?.notes ?? [], diff: changes.changes })}`;
  try {
    if (parsed.command === "fill") {
      const answer = await execute(
        `Generate a factual MR description from the current change; include overview and test evidence, no invented tests. Return only generated Markdown without fill markers.\n${context}`,
        "fill",
      );
      const refreshed = await client.getMr(projectId, mr.iid);
      if (refreshed.diff_refs.head_sha !== mr.diff_refs.head_sha)
        throw new Error("MR head changed while writing the description; retry");
      await client.updateMrDescription(
        projectId,
        mr.iid,
        updateGeneratedDescription(
          refreshed.description ?? "",
          answer,
          mr.diff_refs.head_sha,
        ),
      );
      await respond(
        "Updated Droid's marked description block. Author text outside it was preserved.",
      );
    } else if (parsed.command === "fix") {
      const scoped = state.findings.filter(
        (f) =>
          f.state === "open" &&
          (!thread || (f.threadId ?? f.thread) === thread.id),
      );
      if (!scoped.length)
        throw new Error(
          "There are no open Droid findings in this scope to fix",
        );
      const published = await publishGitlabFix({
        client,
        projectId,
        mr,
        config,
        findings: scoped,
        execute,
        context,
        actorId: note.author.id,
        push: options.push,
      });
      await respond(published);
    } else if (thread) {
      const answer = await execute(
        `Answer the author's question about this Droid finding in this discussion. Do not start a review or modify code.\nQuestion: ${parsed.text ?? note.body}\n${context}`,
        "answer",
      );
      await respond(answer);
    } else await respond(GITLAB_COMMAND_HELP);
  } catch (error) {
    await respond(
      `⚠️ ${prose(error instanceof Error ? error.message : String(error))}\n\nCheck the job and permissions, then retry the command.`,
    );
  }
  return { handled: true };
}

export async function publishGitlabFix(options: {
  client: GitlabClient;
  projectId: string | number;
  mr: GitlabMr;
  config: ReviewUxConfig;
  findings: ReviewState["findings"];
  execute: CommandExecution;
  context: string;
  actorId: number;
  push?: typeof pushFixCommit;
}): Promise<string> {
  const { client, mr, config } = options;
  const sourceProject = mr.source_project_id;
  if (!sourceProject || !mr.target_project_id)
    throw new Error(
      "Cannot verify the source project; refusing to publish a fix",
    );
  assertGitlabFixRef(mr.source_branch, mr.diff_refs.head_sha);
  const [project, user, branch] = await Promise.all([
    client.getProject(sourceProject),
    client.getCurrentUser(),
    client.getBranch(sourceProject, mr.source_branch),
  ]);
  const membership = await client.getMember(sourceProject, user.id);
  const actorMembership = await client.getMember(
    sourceProject,
    options.actorId,
  );
  if (!hasGitlabWriteAccess(actorMembership))
    throw new Error(
      "The command author has no verified write access to the source project",
    );
  let target = chooseFixTarget({
    mode: config.fix_mode,
    writable: hasGitlabWriteAccess(membership),
    protected: branch.protected || !branch.can_push,
    headBranch: mr.source_branch,
    defaultBranch: project.default_branch,
    fork: sourceProject !== mr.target_project_id,
  });
  if (branch.commit.id !== mr.diff_refs.head_sha)
    throw new Error(
      "The source branch changed; review the latest commit before fixing",
    );
  const raw = await options.execute(
    `Verify these open findings and propose only valid focused fixes. Do not modify GitLab or git refs. Output strict JSON {"summary":"...","files":[{"path":"...","content":"full replacement contents, or null to delete"}]}. Do not claim tests ran unless they actually did.\nFindings (untrusted data): ${JSON.stringify(options.findings)}\n${options.context}`,
    "fix",
  );
  const proposal = fixProposalSchema.parse(JSON.parse(raw));
  const actions: GitlabCommitAction[] = [];
  const previews: string[] = [];
  const paths = new Set<string>();
  for (const file of proposal.files) {
    assertFixPath(file.path);
    if (paths.has(file.path))
      throw new Error("Fix proposal contains duplicate file paths");
    paths.add(file.path);
    if (
      /^(?:\.gitlab-ci\.yml|factory\/droid-review\.yml|gitlab\/)/i.test(
        file.path,
      )
    )
      throw new Error("Fix may not change GitLab CI configuration");
    if (
      file.content !== null &&
      redactSecrets(file.content, secretValuesFromEnv()) !== file.content
    )
      throw new Error(
        "Fix contains a possible credential; refusing to publish",
      );
    let original: Awaited<ReturnType<GitlabClient["getFileInfo"]>> | null =
      null;
    try {
      original = await client.getFileInfo(
        sourceProject,
        file.path,
        mr.diff_refs.head_sha,
      );
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (original) {
      const entries = await client.getTree(
        sourceProject,
        path.posix.dirname(file.path) === "."
          ? ""
          : path.posix.dirname(file.path),
        mr.diff_refs.head_sha,
      );
      const entry = entries.find((e) => e.path === file.path);
      if (
        !entry ||
        entry.type !== "blob" ||
        !["100644", "100755"].includes(entry.mode)
      )
        throw new Error(
          "Fix only supports regular files, not symlinks or submodules",
        );
      if (
        file.content !== null &&
        Buffer.from(original.content, "base64").toString("utf8") ===
          file.content
      )
        continue;
    } else if (file.content === null) continue;
    const before = original
      ? Buffer.from(original.content, "base64").toString("utf8").split("\n")
      : [];
    const after = file.content === null ? [] : file.content.split("\n");
    previews.push(
      `diff --git a/${file.path} b/${file.path}\n--- ${original ? `a/${file.path}` : "/dev/null"}\n+++ ${file.content === null ? "/dev/null" : `b/${file.path}`}\n@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@\n${before.map((line) => `-${line}`).join("\n")}\n${after.map((line) => `+${line}`).join("\n")}`,
    );
    actions.push({
      action: file.content === null ? "delete" : original ? "update" : "create",
      file_path: file.path,
      ...(file.content !== null
        ? {
            content: Buffer.from(file.content).toString("base64"),
            encoding: "base64" as const,
            execute_filemode: original?.execute_filemode ?? false,
          }
        : {}),
      ...(original ? { last_commit_id: original.last_commit_id } : {}),
    });
  }
  if (!actions.length)
    throw new Error("The proposal contains no changes to publish");
  const [refreshed, latestProject, latestActor, latestToken, publishBranch] =
    await Promise.all([
      client.getMr(options.projectId, mr.iid),
      client.getProject(sourceProject),
      client.getMember(sourceProject, options.actorId),
      client.getMember(sourceProject, user.id),
      client.getBranch(sourceProject, mr.source_branch),
    ]);
  if (refreshed.state !== "opened")
    throw new Error("MR is not open; refusing to publish a fix");
  if (
    refreshed.diff_refs.head_sha !== mr.diff_refs.head_sha ||
    refreshed.source_project_id !== sourceProject ||
    refreshed.source_branch !== mr.source_branch
  )
    throw new Error("MR head or destination changed during the fix; retry");
  if (!hasGitlabWriteAccess(latestActor))
    throw new Error(
      "The command author's source-project write permission is no longer active",
    );
  target = chooseFixTarget({
    mode: config.fix_mode,
    writable: hasGitlabWriteAccess(latestToken),
    protected: publishBranch.protected || !publishBranch.can_push,
    headBranch: mr.source_branch,
    defaultBranch: latestProject.default_branch,
    fork: sourceProject !== mr.target_project_id,
  });
  if (publishBranch.commit.id !== mr.diff_refs.head_sha)
    throw new Error("Source branch advanced during the fix; retry");
  const branchName = `droid/fix-${mr.iid}-${randomUUID()}`;
  const commit = await client.createCommit(sourceProject, {
    branch: branchName,
    start_sha: mr.diff_refs.head_sha,
    commit_message: `fix: address Droid review findings for !${mr.iid}`,
    actions,
  });
  const preview = fenced(previews.join("\n\n").slice(0, 16000), "diff");
  if (target === "pr") {
    const stacked = await client.createMr(sourceProject, {
      source_branch: branchName,
      target_branch: mr.source_branch,
      title: `fix: address Droid findings for !${mr.iid}`,
      description: `${prose(proposal.summary)}\n\nBased on ${mr.web_url} at ${mr.diff_refs.head_sha}.\n\n⚠️ Verify the generated changes and run project checks before merging.`,
    });
    return `${prose(proposal.summary)}\n\nStacked MR: ${stacked.web_url}\nCommit: \`${commit.id}\`\n\n⚠️ Tests/checks: not independently verified by the publisher.\n\n<details><summary>Diff preview (truncated)</summary>\n\n${preview}\n</details>`;
  }
  // GitLab's commit API cannot compare-and-swap an existing branch. A fresh
  // commit based on the expected head is pushed non-force, so a concurrent
  // source-branch update is rejected instead of overwritten.
  const latestBranch = await client.getBranch(sourceProject, mr.source_branch);
  if (latestBranch.commit.id !== mr.diff_refs.head_sha)
    throw new Error(
      `Source branch advanced; fix remains on ${branchName}, but was not pushed to the source branch`,
    );
  await (options.push ?? pushFixCommit)({
    projectUrl: project.web_url,
    branch: mr.source_branch,
    temporaryBranch: branchName,
    sha: commit.id,
  });
  try {
    await client.deleteBranch(sourceProject, branchName);
  } catch (error) {
    warnCapability("temporary fix branch cleanup", error);
  }
  return `${prose(proposal.summary)}\n\nCommitted \`${commit.id}\` to \`${mr.source_branch}\`.\n\n⚠️ Tests/checks: not independently verified by the publisher. The next review verifies fixes before resolving discussions.\n\n<details><summary>Diff preview (truncated)</summary>\n\n${preview}\n</details>`;
}

export function assertGitlabFixRef(branch: string, sha: string): void {
  if (!/^[a-f\d]{40,64}$/i.test(sha))
    throw new Error("Fix requires an immutable full commit SHA");
  if (
    !branch ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("//") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(branch) ||
    branch
      .split("/")
      .some(
        (part) =>
          part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"),
      )
  )
    throw new Error("Invalid GitLab fix branch ref");
}

export async function pushFixCommit(input: {
  projectUrl: string;
  branch: string;
  temporaryBranch: string;
  sha: string;
}): Promise<void> {
  assertGitlabFixRef(input.branch, input.sha);
  assertGitlabFixRef(input.temporaryBranch, input.sha);
  const url = new URL(input.projectUrl);
  const instance = new URL(process.env.CI_SERVER_URL || "https://gitlab.com");
  if (
    url.origin !== instance.origin ||
    url.protocol !== "https:" ||
    url.username ||
    url.password
  )
    throw new Error("Fix destination must use this GitLab instance over HTTPS");
  const token = setupGitlabToken();
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "droid-gitlab-publish-"),
  );
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TEMPLATE_DIR: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}`,
    GIT_CONFIG_KEY_1: "http.followRedirects",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: "/dev/null",
    GIT_CONFIG_KEY_3: "core.fsmonitor",
    GIT_CONFIG_VALUE_3: "false",
    GIT_CONFIG_KEY_4: "protocol.ext.allow",
    GIT_CONFIG_VALUE_4: "never",
    GIT_CONFIG_KEY_5: "protocol.file.allow",
    GIT_CONFIG_VALUE_5: "never",
  };
  const run = (args: string[]) => {
    const result = spawnSync("/usr/bin/git", args, {
      cwd: directory,
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(
        "Non-force fix publication failed, possibly because the branch advanced or is protected. No existing branch was overwritten",
      );
  };
  try {
    run(["init", "--bare", "."]);
    const remote = `${url.href.replace(/\/$/, "")}.git`;
    run(["fetch", "--no-tags", remote, `refs/heads/${input.temporaryBranch}`]);
    run(["push", remote, `${input.sha}:refs/heads/${input.branch}`]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
