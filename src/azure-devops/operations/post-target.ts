/**
 * Where the post steps are allowed to write.
 *
 * The state file sits in a directory the review passes can modify (they run
 * as the same OS user with an Execute tool), so nothing in it may choose the
 * collection, project, repository, or pull request the token writes to. Those
 * come from Azure Pipelines' own variables; the state file can only confirm
 * them.
 */

import { parseAzureDevopsContext } from "../context";

export type AzureDevopsPostTarget = {
  collectionUri: string;
  project: string;
  repositoryId: string;
  pullRequestId: number;
};

export class PostTargetMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostTargetMismatchError";
  }
}

export function resolvePostTarget(
  state: Partial<
    Record<keyof AzureDevopsPostTarget, string | number | null | undefined>
  >,
  env: NodeJS.ProcessEnv = process.env,
): AzureDevopsPostTarget {
  const ctx = parseAzureDevopsContext(env);
  if (!ctx.pullRequest) {
    throw new PostTargetMismatchError(
      "System.PullRequest.PullRequestId is not set; refusing to post outside a pull request build.",
    );
  }
  const target: AzureDevopsPostTarget = {
    collectionUri: ctx.collectionUri,
    project: ctx.project.id ?? ctx.project.name,
    repositoryId: ctx.repository.id,
    pullRequestId: ctx.pullRequest.id,
  };
  for (const key of Object.keys(target) as Array<keyof AzureDevopsPostTarget>) {
    const fromState = state[key];
    if (
      fromState !== undefined &&
      fromState !== null &&
      String(fromState) !== String(target[key])
    ) {
      throw new PostTargetMismatchError(
        `State file names ${key} ${JSON.stringify(fromState)}, but this build belongs to ${JSON.stringify(target[key])}; refusing to post.`,
      );
    }
  }
  return target;
}
