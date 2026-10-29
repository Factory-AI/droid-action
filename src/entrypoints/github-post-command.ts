import * as core from "@actions/core";
import { lstat, readFile } from "fs/promises";
import { createOctokit, type Octokits } from "../github/api/client";
import { listDroidThreads } from "../github/operations/review-lifecycle";
import { redactCredentials } from "../utils/redact-credentials";

export type PostCommandOptions = {
  owner: string;
  repo: string;
  prNumber: number;
  actor: string;
  mode: "question";
  expectedHead: string;
  outputPath: string;
  rootCommentId: number;
  success: boolean;
};

/** Metadata is bound by immutable prepare outputs, never by the model's proposal. */
export async function postCommand(
  octokit: Octokits,
  options: PostCommandOptions,
): Promise<void> {
  const { owner, repo, prNumber } = options;
  const threads = await listDroidThreads({ octokit, owner, repo, prNumber });
  const selected = threads.filter(
    (thread) => thread.commentId === options.rootCommentId,
  );
  if (!options.rootCommentId || !selected.length)
    throw new Error(
      "The selected comment is not a verified Droid finding on this PR",
    );
  const reply = async (body: string) => {
    const safeBody = redactCredentials(body);
    await octokit.rest.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      comment_id: options.rootCommentId,
      body: safeBody,
    });
  };
  try {
    if (!options.success)
      throw new Error(
        "Droid could not finish this request. Please retry the command.",
      );
    const stat = await lstat(options.outputPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
      throw new Error(
        "The command output is missing, too large, or not a regular file",
      );
    const text = await readFile(options.outputPath, "utf8");
    if (!text.trim() || text.length > 60000)
      throw new Error("The thread answer is empty or too long");
    await reply(text);
    core.setOutput("conclusion", "success");
  } catch (error) {
    const message = redactCredentials(
      error instanceof Error ? error.message : String(error),
    );
    await reply(`Droid could not answer this question. ${message}`);
    core.setOutput("conclusion", "failure");
    throw new Error(message);
  }
}

export async function run(): Promise<void> {
  const mode = process.env.COMMAND_MODE;
  const prNumber = Number(process.env.COMMAND_PR_NUMBER);
  const root = process.env.COMMAND_ROOT_COMMENT_ID;
  if (
    mode !== "question" ||
    !Number.isSafeInteger(prNumber) ||
    prNumber <= 0 ||
    !process.env.COMMAND_EXPECTED_HEAD ||
    !/^[0-9a-f]{40,64}$/i.test(process.env.COMMAND_EXPECTED_HEAD) ||
    !process.env.REPO_OWNER ||
    !process.env.REPO_NAME ||
    !process.env.COMMAND_ACTOR ||
    !process.env.COMMAND_OUTPUT_PATH ||
    !process.env.GITHUB_TOKEN ||
    !root ||
    !/^\d+$/.test(root) ||
    !Number.isSafeInteger(Number(root)) ||
    Number(root) <= 0
  )
    throw new Error("Missing or invalid trusted command outputs");
  await postCommand(createOctokit(process.env.GITHUB_TOKEN), {
    owner: process.env.REPO_OWNER,
    repo: process.env.REPO_NAME,
    prNumber,
    actor: process.env.COMMAND_ACTOR,
    expectedHead: process.env.COMMAND_EXPECTED_HEAD,
    mode,
    outputPath: process.env.COMMAND_OUTPUT_PATH,
    rootCommentId: Number(root),
    success: process.env.DROID_SUCCESS === "true",
  });
}
if (import.meta.main)
  run().catch((error) => {
    core.setFailed(
      redactCredentials(error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
  });
