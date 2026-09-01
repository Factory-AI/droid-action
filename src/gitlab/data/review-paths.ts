/**
 * On-disk contract shared by the GitLab review steps.
 *
 * The CI/CD Component runs four separate processes (prepare → droid exec
 * pass 1 → prepare-validator → droid exec pass 2 → post-review →
 * update-comment-link), so every path they exchange has to resolve
 * identically in each one. Keeping the resolution here means a single
 * definition per file, each overridable by env for local runs.
 */

import * as path from "path";

export function promptFilePath(): string {
  return process.env.DROID_PROMPT_FILE || "/tmp/droid-prompts/droid-prompt.txt";
}

export function promptsDir(): string {
  return path.dirname(promptFilePath());
}

export function candidatesFilePath(): string {
  return (
    process.env.REVIEW_CANDIDATES_PATH ||
    path.join(promptsDir(), "review_candidates.json")
  );
}

export function validatedFilePath(): string {
  return (
    process.env.REVIEW_VALIDATED_PATH ||
    path.join(promptsDir(), "review_validated.json")
  );
}

/** Written by gitlab-post-review, read by gitlab-update-comment-link. */
export function postResultsFilePath(): string {
  return (
    process.env.REVIEW_POST_RESULTS_PATH ||
    path.join(promptsDir(), "review_post_results.json")
  );
}

export function resolvedEnvShimPath(): string {
  return (
    process.env.DROID_RESOLVED_ENV_FILE ||
    path.join(promptsDir(), "resolved-env.sh")
  );
}

export function stateFilePath(): string {
  return (
    process.env.DROID_STATE_FILE ||
    path.join(process.env.CI_PROJECT_DIR || "/tmp", ".droid-state.json")
  );
}
