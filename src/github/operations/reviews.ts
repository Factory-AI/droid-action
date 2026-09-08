export type GitHubReviewCommentPayload = {
  path: string;
  body: string;
  line?: number;
  side?: string;
  start_line?: number;
  start_side?: string;
  position?: number;
};

export type GitHubReviewCreateClient = {
  rest: {
    pulls: {
      createReview: (...args: any[]) => Promise<{ data: { id?: number } }>;
    };
  };
};

/**
 * Creates one COMMENT review and returns its GitHub review ID.
 *
 * `commitId` pins the review to the commit the anchors were computed
 * against. Without it GitHub resolves `line`/`side` against the PR's
 * current head, so a push that lands between diff generation and posting
 * makes the anchors point at different code or fail the whole review.
 */
export async function createGitHubCommentReview(options: {
  client: GitHubReviewCreateClient;
  owner: string;
  repo: string;
  prNumber: number;
  body?: string;
  comments?: GitHubReviewCommentPayload[];
  commitId?: string | null;
}): Promise<number | undefined> {
  const { client, owner, repo, prNumber, body, comments, commitId } = options;
  const response = await client.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event: "COMMENT",
    ...(commitId ? { commit_id: commitId } : {}),
    ...(body ? { body } : {}),
    ...(comments && comments.length > 0 ? { comments } : {}),
  });
  return response.data.id;
}
