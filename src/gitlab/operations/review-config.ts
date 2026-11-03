import {
  parseReviewConfigYaml,
  resolveReviewUxConfig,
  reviewInputsFromEnvironment,
  REVIEW_CONFIG_PATH,
  type ReviewUxConfig,
} from "../../core/review/config";
import type { GitlabClient } from "../api/client";
import type { GitlabMr } from "../types";
import { isMissingFile } from "./review-ux";

/** Configuration is pinned to the actual target branch, never the MR checkout. */
export async function loadGitlabReviewConfig(
  client: GitlabClient,
  projectId: string | number,
  mr: GitlabMr,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReviewUxConfig> {
  const branch = await client.getBranch(projectId, mr.target_branch);
  if (!/^[a-f\d]{40,64}$/i.test(branch.commit.id))
    throw new Error(
      "Cannot determine immutable GitLab target commit for review configuration",
    );
  let fileConfig: Record<string, unknown> = {};
  try {
    const raw = await client.getRepositoryFile(
      projectId,
      REVIEW_CONFIG_PATH,
      branch.commit.id,
    );
    const entry = (
      await client.getTree(projectId, ".factory", branch.commit.id)
    ).find((item) => item.path === REVIEW_CONFIG_PATH);
    if (
      !entry ||
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode)
    )
      throw new Error(
        "GitLab review configuration must be a regular base-branch file, not a symlink or submodule",
      );
    fileConfig = parseReviewConfigYaml(raw);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return resolveReviewUxConfig({
    fileConfig: {
      automatic_review: true,
      automatic_security_review: true,
      ...fileConfig,
    },
    inputs: reviewInputsFromEnvironment(env),
  });
}
