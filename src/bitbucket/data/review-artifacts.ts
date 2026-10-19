/**
 * Fetch the pull request, diff and comments, and write the three review
 * artifacts (pr.diff, existing_comments.json, pr_description.txt) the
 * review prompts read from disk.
 */

import { writeReviewArtifacts } from "../../core/review/artifacts/write";
import type { ReviewArtifactPaths } from "../../core/review/artifacts/types";
import type {
  BitbucketClient,
  BitbucketComment,
  BitbucketPullRequest,
} from "../types";

export type BitbucketReviewArtifacts = ReviewArtifactPaths & {
  diff: string;
  comments: BitbucketComment[];
};

export function buildDescriptionContent(pr: BitbucketPullRequest): string {
  return `Title: ${pr.title}\n\n${pr.description}\n`;
}

export async function computeReviewArtifacts(opts: {
  client: BitbucketClient;
  pr: BitbucketPullRequest;
  outDir: string;
}): Promise<BitbucketReviewArtifacts> {
  const { client, pr, outDir } = opts;
  const [diff, comments] = await Promise.all([
    client.getDiff(),
    client.listComments(),
  ]);
  const paths = await writeReviewArtifacts(
    outDir,
    { diff, comments, description: buildDescriptionContent(pr) },
    {
      diff: "pr.diff",
      comments: "existing_comments.json",
      description: "pr_description.txt",
    },
  );
  return { ...paths, diff, comments };
}
