import { createHash } from "node:crypto";
import type { Octokits } from "../api/client";
import { identicalReviewDiffSkipReason } from "../../core/review/incremental";
import { reviewPromptSettingsFromEnvironment } from "../../core/review/prompts/settings";
import { buildReviewInput, reviewInputPath } from "../../core/review/worker";
import {
  fetchCommits,
  fetchPullRequest,
  hasCommit,
} from "../../core/worker/checkout";
import {
  describeFailure,
  requiredEnv,
  writePrivateJson,
} from "../../core/worker/step";
import {
  fetchImmutableReviewDiff,
  finishReviewLifecycle,
  saveReviewLifecycle,
  stateFindings,
  type ReviewLifecycleRun,
} from "../operations/review-lifecycle";

const COMMIT = /^[a-f0-9]{7,64}$/i;

/**
 * Whether the head holds nothing the last review did not see. Both sides of
 * each comparison come from GitHub's immutable diff, the one the publisher
 * stores a hash of. A diff that cannot be fetched skips nothing.
 */
async function noNewChanges(
  octokit: Octokits,
  run: ReviewLifecycleRun,
  base: string,
  incremental: boolean,
): Promise<string | undefined> {
  if (run.full || !run.state.head) return undefined;
  const { owner, repo, head } = run;
  try {
    const diff = await fetchImmutableReviewDiff(
      octokit,
      incremental
        ? { owner, repo, base: run.state.head, head, direct: true }
        : { owner, repo, base, head },
    );
    return identicalReviewDiffSkipReason({
      full: run.full,
      incrementalUsed: incremental,
      empty: !diff.trim(),
      hash: createHash("sha256").update(diff).digest("hex"),
      previousHash: run.state.diffHash,
      previousHead: run.state.head,
    });
  } catch {
    return undefined;
  }
}

/**
 * The second half of a review's preparation, which is everything a review
 * needs of GitHub: it fetches the commits the worker reads into the job's
 * checkout, decides the one skip that needs a diff, and leaves the worker's
 * input for the step that runs it. That step holds no GitHub credential.
 */
export async function prepareReviewInput(options: {
  octokit: Octokits;
  githubToken: string;
  run: ReviewLifecycleRun;
  pullRequest: {
    baseRefName: string;
    headRefName: string;
    isFork: boolean;
    title: string;
    body: string;
  };
  focus?: string;
}): Promise<{ skipReason?: string }> {
  const { octokit, run } = options;
  const { owner, repo, prNumber, head, base } = run;
  const checkout = {
    cwd: requiredEnv("GITHUB_WORKSPACE"),
    githubToken: options.githubToken,
  };
  if (!base) throw new Error("The pull request's base commit is not known.");
  // The pull ref is in the base repository, so this serves a fork's head.
  await fetchPullRequest(checkout, prNumber, [base]).catch((error) => {
    console.warn(
      `The pull request's commits could not be fetched: ${describeFailure(error)}`,
    );
  });
  if (
    !(await hasCommit(checkout, head)) ||
    !(await hasCommit(checkout, base))
  ) {
    throw new Error("Droid could not fetch the pull request's commits.");
  }

  const reviewedHead = COMMIT.test(run.state.head) ? run.state.head : undefined;
  let reviewedHeadFetched = false;
  if (reviewedHead) {
    // Fetched apart from the rest: after a force push the remote may no
    // longer have it, and the review then runs on the whole change.
    await fetchCommits(checkout, [reviewedHead]).catch(() => {});
    reviewedHeadFetched = await hasCommit(checkout, reviewedHead);
  }
  const incremental = run.incrementalBaseSha !== undefined;

  const skipReason = await noNewChanges(
    octokit,
    run,
    base,
    incremental && reviewedHeadFetched,
  );
  if (skipReason) {
    run.skipReason = skipReason;
    await saveReviewLifecycle(run);
    await finishReviewLifecycle({
      octokit,
      run,
      input: {
        state: "skipped",
        skipReason,
        head,
        previousHead: run.state.head,
        previousBody: run.previousBody,
      },
    });
    return { skipReason };
  }

  const [issueComments, reviewComments] = await Promise.all([
    octokit.rest.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    }),
    octokit.rest.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);
  await writePrivateJson(
    reviewInputPath(),
    buildReviewInput({
      owner,
      repo,
      prNumber,
      runId: run.runId,
      runAttempt: run.runAttempt,
      base,
      head,
      pullRequest: options.pullRequest,
      comments: { issueComments, reviewComments },
      reviewedHead,
      reviewedHeadFetched,
      incremental,
      findings: stateFindings(run.state),
      securityOnly: run.securityOnly,
      focus: options.focus,
      settings: reviewPromptSettingsFromEnvironment(),
    }),
  );
  return {};
}
