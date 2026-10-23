import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import { GITHUB_API_URL } from "./config";
import {
  redactDeep,
  secretValuesFromEnv,
} from "../../utils/redact-credentials";

export type Octokits = {
  rest: Octokit;
  graphql: typeof graphql;
};

// Request option keys that route or carry a request rather than hold content.
const TRANSPORT_KEYS = new Set([
  "method",
  "url",
  "baseUrl",
  "headers",
  "mediaType",
  "request",
]);

/**
 * Comments, reviews, PR descriptions and replies can all carry model output,
 * which can quote anything a tool printed, so every write is redacted here
 * rather than trusting each caller to.
 */
export function redactRequestContent(
  options: Record<string, unknown>,
  token?: string,
): void {
  const secrets = [
    ...new Set([...(token ? [token] : []), ...secretValuesFromEnv()]),
  ].sort((a, b) => b.length - a.length);
  for (const [key, value] of Object.entries(options)) {
    if (!TRANSPORT_KEYS.has(key)) {
      options[key] = redactDeep(value, secrets);
    }
  }
}

export function withRequestRedaction<T extends Octokit>(
  octokit: T,
  token?: string,
): T {
  octokit.hook.before("request", (options) => {
    if (options.method !== "GET" && options.method !== "HEAD") {
      redactRequestContent(
        options as unknown as Record<string, unknown>,
        token,
      );
    }
  });
  return octokit;
}

export function createOctokit(token: string): Octokits {
  return {
    rest: withRequestRedaction(
      new Octokit({
        auth: token,
        baseUrl: GITHUB_API_URL,
      }),
      token,
    ),
    graphql: graphql.defaults({
      baseUrl: GITHUB_API_URL,
      headers: {
        authorization: `token ${token}`,
      },
      request: {
        // GraphQL mutations post content too; every GraphQL call is a POST.
        hook: (
          request: (options: Record<string, unknown>) => Promise<unknown>,
          options: Record<string, unknown>,
        ) => {
          redactRequestContent(options, token);
          return request(options);
        },
      },
    }),
  };
}
