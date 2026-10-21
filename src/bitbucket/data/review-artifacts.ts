/**
 * Fetch the diff and write the three review artifacts (pr.diff,
 * existing_comments.json, pr_description.txt) the review prompts read from
 * disk. The comments come from the caller, which already listed them to
 * find the tracking comment.
 */

import { writeReviewArtifacts } from "../../core/review/artifacts/write";
import type { ReviewArtifactPaths } from "../../core/review/artifacts/types";
import type {
  BitbucketClient,
  BitbucketComment,
  BitbucketPullRequest,
} from "../types";

export type BitbucketReviewArtifacts = ReviewArtifactPaths & {
  diffTruncated: boolean;
};

export function buildDescriptionContent(pr: BitbucketPullRequest): string {
  return `Title: ${pr.title}\n\n${pr.description}\n`;
}

export async function computeReviewArtifacts(opts: {
  client: BitbucketClient;
  pr: BitbucketPullRequest;
  comments: BitbucketComment[];
  outDir: string;
}): Promise<BitbucketReviewArtifacts> {
  const { client, pr, comments, outDir } = opts;
  const diff = await client.getDiff();
  const paths = await writeReviewArtifacts(
    outDir,
    { diff: diff.text, comments, description: buildDescriptionContent(pr) },
    {
      diff: "pr.diff",
      comments: "existing_comments.json",
      description: "pr_description.txt",
    },
  );
  return { ...paths, diffTruncated: diff.truncated };
}
