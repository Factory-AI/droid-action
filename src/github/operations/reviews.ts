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

/** Creates one COMMENT review and returns its GitHub review ID. */
export async function createGitHubCommentReview(options: {
  client: GitHubReviewCreateClient;
  owner: string;
  repo: string;
  prNumber: number;
  body?: string;
  comments?: GitHubReviewCommentPayload[];
}): Promise<number | undefined> {
  const { client, owner, repo, prNumber, body, comments } = options;
  const response = await client.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event: "COMMENT",
    ...(body ? { body } : {}),
    ...(comments && comments.length > 0 ? { comments } : {}),
  });
  return response.data.id;
}
