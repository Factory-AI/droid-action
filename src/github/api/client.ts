import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { graphql } from "@octokit/graphql";
import { GITHUB_API_URL } from "./config";

const OctokitWithRetry = Octokit.plugin(retry);

export type Octokits = {
  rest: Octokit;
  graphql: typeof graphql;
};

export function createOctokit(token: string): Octokits {
  return {
    rest: new OctokitWithRetry({
      auth: token,
      baseUrl: GITHUB_API_URL,
      retry: {
        // Retry on 5xx errors, timeouts, and connection failures
        // Rate limiting (429) is handled by Octokit's built-in rate limit plugin
        doNotRetry: [], // Retry all retriable errors by default
        retries: 3,
      },
    }),
    graphql: graphql.defaults({
      baseUrl: GITHUB_API_URL,
      headers: {
        authorization: `token ${token}`,
      },
    }),
  };
}
