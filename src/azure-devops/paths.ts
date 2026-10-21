import * as fs from "fs/promises";
import * as path from "path";

/**
 * Files shared by the Azure DevOps review steps. Each step is its own
 * process, so every path resolves from the same env vars. The defaults sit
 * under the agent temp directory, outside the checked-out PR, so a branch
 * cannot plant a symlink that redirects these writes.
 */

function tempRoot(env: NodeJS.ProcessEnv): string {
  return env.AGENT_TEMPDIRECTORY || env.TMPDIR || "/tmp";
}

export function promptFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.DROID_PROMPT_FILE ||
    path.join(tempRoot(env), "droid-prompts", "droid-prompt.txt")
  );
}

export function promptsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.dirname(promptFilePath(env));
}

export function stateFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.DROID_STATE_FILE || path.join(promptsDir(env), ".droid-state.json")
  );
}

export function candidatesFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.REVIEW_CANDIDATES_PATH ||
    path.join(promptsDir(env), "review_candidates.json")
  );
}

export function validatedFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.REVIEW_VALIDATED_PATH ||
    path.join(promptsDir(env), "review_validated.json")
  );
}

export function postResultsFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.REVIEW_POST_RESULTS_PATH ||
    path.join(promptsDir(env), "review_post_results.json")
  );
}

export function resolvedEnvShimPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.DROID_RESOLVED_ENV_FILE || path.join(promptsDir(env), "resolved-env.sh")
  );
}

export type AzureDevopsPrepareState = {
  shouldRunReview: boolean;
  reason?: string;
  collectionUri: string;
  project: string;
  repositoryId: string;
  repository: string;
  pullRequestId: number | null;
  iterationId: number | null;
  trackingThreadId: number | null;
  trackingCommentId: number | null;
  buildUrl: string | null;
  jobUrl: string | null;
  promptPath: string | null;
  resolvedModel: string | null;
  resolvedReasoningEffort: string | null;
  diffPath: string | null;
  commentsPath: string | null;
  descriptionPath: string | null;
  candidatesPath: string | null;
  validatedPath: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  headSha: string | null;
  includeSuggestions: boolean;
  securityReviewEnabled: boolean;
  triggeredBy: string | null;
  /** Set when Pass 1 left no usable candidates, so Pass 2 never really ran. */
  validatorSkippedReason?: string;
};

export async function writeState(
  state: AzureDevopsPrepareState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = stateFilePath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
}

export async function readState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AzureDevopsPrepareState | null> {
  try {
    const raw = await fs.readFile(stateFilePath(env), "utf8");
    return JSON.parse(raw) as AzureDevopsPrepareState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}
