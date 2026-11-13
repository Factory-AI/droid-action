import * as core from "@actions/core";
import type { AppTokenPermissions } from "../github/token-permissions";
import type { FetchLike } from "./api";

/**
 * Everything the judge may do on GitHub: read the pull request, its code,
 * its issues and its CI results. Nothing it holds can write.
 */
export const JUDGE_TOKEN_PERMISSIONS = {
  contents: "read",
  pull_requests: "read",
  issues: "read",
  checks: "read",
  statuses: "read",
} as const satisfies AppTokenPermissions;

type MintDependencies = {
  getIdToken?: () => Promise<string>;
  fetchImpl?: FetchLike;
};

/**
 * Mints a second Factory Droid App token for the judge, narrowed to read
 * access. A token's permissions are fixed when it is issued, so the review
 * phase's token cannot be reused with less authority. Unlike the review
 * token this one never becomes a step output, and a refused exchange throws
 * instead of ending the process.
 */
export async function mintJudgeToken(
  dependencies: MintDependencies = {},
): Promise<string> {
  const getIdToken =
    dependencies.getIdToken ?? (() => core.getIDToken("droid-github-action"));
  const fetchImpl: FetchLike =
    dependencies.fetchImpl ?? ((url, init) => fetch(url, init));
  let oidcToken: string;
  try {
    oidcToken = await getIdToken();
  } catch {
    throw new Error(
      "Could not fetch an OIDC token for the judge; the job needs `id-token: write`",
    );
  }
  const response = await fetchImpl(
    "https://app.factory.ai/api/github/token-exchange",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permissions: JUDGE_TOKEN_PERMISSIONS }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      error_code?: unknown;
    };
    const code = [failure.error, failure.error_code]
      .filter((value): value is string => typeof value === "string")
      .join("/");
    throw new Error(
      `Judge token exchange failed with status ${response.status}${code ? ` (${code})` : ""}`,
    );
  }
  const { token } = (await response.json()) as { token?: unknown };
  if (typeof token !== "string" || !token)
    throw new Error("Judge token exchange returned no token");
  core.setSecret(token);
  return token;
}
