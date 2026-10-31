import * as core from "@actions/core";
import { lstat, readFile } from "fs/promises";
import { createOctokit, type Octokits } from "../github/api/client";
import { listDroidThreads } from "../github/operations/review-lifecycle";
import { publishReviewFix } from "../github/operations/review-fix";
import { fixProposalSchema, type FixMode } from "../core/review/fix";
import { redactCredentials } from "../utils/redact-credentials";
import { replyToPullRequestComment } from "../github/operations/comments/reply";

export type PostCommandOptions = {
  owner: string;
  repo: string;
  prNumber: number;
  actor: string;
  mode: "fix" | "question";
  expectedHead: string;
  fixMode: FixMode;
  outputPath: string;
  rootCommentId?: number;
  success: boolean;
};

/** Metadata is bound by immutable prepare outputs, never by the model's proposal. */
export async function postCommand(
  octokit: Octokits,
  options: PostCommandOptions,
): Promise<void> {
  const { owner, repo, prNumber } = options;
  const threads = await listDroidThreads({ octokit, owner, repo, prNumber });
  const selected = options.rootCommentId
    ? threads.filter((thread) => thread.commentId === options.rootCommentId)
    : threads.filter((thread) => !thread.resolved);
  if (options.rootCommentId && !selected.length)
    throw new Error(
      "The selected comment is not a verified Droid finding on this PR",
    );
  let replyAttempted = false;
  const reply = async (body: string) => {
    replyAttempted = true;
    await replyToPullRequestComment({
      octokit,
      owner,
      repo,
      prNumber,
      body,
      type: options.rootCommentId ? "review" : "issue",
      commentId: options.rootCommentId ?? 0,
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
    if (options.mode === "question") {
      if (!options.rootCommentId)
        throw new Error(
          "Questions must be answered inside their verified Droid review thread",
        );
      if (!text.trim() || text.length > 60000)
        throw new Error("The thread answer is empty or too long");
      await reply(text);
    } else {
      if (!selected.some((thread) => !thread.resolved))
        throw new Error(
          "No selected Droid findings are still open; no fix was published",
        );
      const raw: unknown = JSON.parse(text);
      // A valid no-op is useful and must not create an empty commit.
      const noOp = fixProposalSchema
        .extend({ files: fixProposalSchema.shape.files.min(0).max(0) })
        .safeParse(raw);
      if (noOp.success) {
        await reply(
          `No fix was published.\n\n${redactCredentials(noOp.data.summary)}\n\n⚠️ Tests were not run.`,
        );
      } else {
        const result = await publishReviewFix(
          octokit,
          {
            owner,
            repo,
            prNumber,
            actor: options.actor,
            expectedHead: options.expectedHead,
            mode: options.fixMode,
            allowedPaths: [
              ...new Set(
                selected
                  .filter((thread) => !thread.resolved)
                  .map((thread) => thread.path),
              ),
            ],
          },
          raw,
        );
        await reply(result.body);
      }
    }
  } catch (error) {
    const message = redactCredentials(
      error instanceof Error ? error.message : String(error),
    );
    if (!replyAttempted)
      await reply(
        `Droid could not ${options.mode === "fix" ? "publish this fix" : "answer this question"}. ${message}`,
      );
    throw new Error(message);
  }
}

export async function run(): Promise<void> {
  const mode = process.env.COMMAND_MODE;
  const fixMode = process.env.COMMAND_FIX_MODE;
  const prNumber = Number(process.env.COMMAND_PR_NUMBER);
  const root = process.env.COMMAND_ROOT_COMMENT_ID;
  if (
    (mode !== "fix" && mode !== "question") ||
    (fixMode !== "commit" && fixMode !== "pr" && fixMode !== "off") ||
    !Number.isSafeInteger(prNumber) ||
    prNumber <= 0 ||
    !process.env.COMMAND_EXPECTED_HEAD ||
    !/^[0-9a-f]{40,64}$/i.test(process.env.COMMAND_EXPECTED_HEAD) ||
    !process.env.REPO_OWNER ||
    !process.env.REPO_NAME ||
    !process.env.COMMAND_ACTOR ||
    !process.env.COMMAND_OUTPUT_PATH ||
    !process.env.GITHUB_TOKEN ||
    (root && (!/^\d+$/.test(root) || !Number.isSafeInteger(Number(root))))
  )
    throw new Error("Missing or invalid trusted command outputs");
  await postCommand(createOctokit(process.env.GITHUB_TOKEN), {
    owner: process.env.REPO_OWNER,
    repo: process.env.REPO_NAME,
    prNumber,
    actor: process.env.COMMAND_ACTOR,
    expectedHead: process.env.COMMAND_EXPECTED_HEAD,
    mode,
    fixMode,
    outputPath: process.env.COMMAND_OUTPUT_PATH,
    ...(root ? { rootCommentId: Number(root) } : {}),
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
