import {
  fetchCommits,
  fetchPullRequest,
  git,
  type GitRepo,
} from "../worker/checkout";
import { StepError, describeFailure } from "../worker/step";
import type { RiskPlan } from "./types";

/**
 * Resolves the current tip of the remote's default branch. Guidelines come
 * from there rather than from the pull request's base commit, because a base
 * can be a branch its author controls (a stacked or retargeted pull request)
 * and GitHub's recorded base commit can lag behind the branch.
 */
async function resolveDefaultBranchTip(repo: GitRepo): Promise<string> {
  const output = await git(["ls-remote", "--symref", "origin", "HEAD"], repo);
  const branch = /^ref: refs\/heads\/\S+\tHEAD$/m.test(output);
  const tip = /^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/m.exec(output)?.[1];
  if (!branch || !tip) {
    throw new StepError(
      "pr_risk_default_branch_unresolved",
      "PR risk could not resolve the default branch",
    );
  }
  return tip;
}

/**
 * Fetches into the checkout the commits one judgment reads: the base, the
 * pull request's head, the default branch's tip, and the two commits of the
 * earlier verdict a re-check is made against. Returns the default branch's
 * tip, the commit the guidelines are read from, which the pull request
 * cannot move.
 */
export async function fetchRiskRevisions(
  plan: Pick<RiskPlan, "pr" | "baseSha" | "incremental">,
  repo: { repoDir: string; githubToken: string },
): Promise<string> {
  const target = { cwd: repo.repoDir, githubToken: repo.githubToken };
  const policySha = await resolveDefaultBranchTip(target);
  await fetchPullRequest(target, plan.pr, [plan.baseSha, policySha]);
  if (plan.incremental) {
    const { priorBaseSha, priorHeadSha } = plan.incremental;
    // Fetched apart from the rest, because the remote may no longer have
    // them. The worker then judges the head afresh and reports why, where a
    // failure here would leave the head with no judgment at all.
    await fetchCommits(target, [priorBaseSha, priorHeadSha]).catch((error) => {
      console.warn(
        `The earlier verdict's commits could not be fetched: ${describeFailure(error)}`,
      );
    });
  }
  return policySha;
}
