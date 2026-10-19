import type { BitbucketAuth } from "./api/http";

/** Environment variables that hold Bitbucket credentials. */
export const BITBUCKET_CREDENTIAL_ENV_VARS = [
  "DROID_BITBUCKET_TOKEN",
  "DROID_BITBUCKET_USERNAME",
  "DROID_BITBUCKET_API_TOKEN",
  // Pipelines exposes this when a step sets `oidc: true`.
  "BITBUCKET_STEP_OIDC_TOKEN",
] as const;

export class MissingBitbucketCredentialsError extends Error {
  constructor() {
    super(
      "Missing Bitbucket credentials. Set DROID_BITBUCKET_TOKEN (Bitbucket Cloud repository/project/workspace " +
        "access token, or Data Center HTTP access token; sent as Bearer) or DROID_BITBUCKET_USERNAME + " +
        "DROID_BITBUCKET_API_TOKEN (Bitbucket Cloud API token with your Atlassian email, or an app password " +
        "with your Bitbucket username; sent as Basic) as secured CI variables.",
    );
    this.name = "MissingBitbucketCredentialsError";
  }
}

export class UnexpandedBitbucketTokenError extends Error {
  constructor(name: string, value: string) {
    super(
      `${name} was passed through as the literal string "${value}" instead of a credential. ` +
        "The CI system did not expand the variable reference; make sure the secret exists and is " +
        "available to this build (secured variables are withheld from fork pull requests).",
    );
    this.name = "UnexpandedBitbucketTokenError";
  }
}

/**
 * A variable reference the CI passed through literally: `$NAME`, `${NAME}`,
 * Bamboo's `${bamboo.NAME}`, or Azure-style `$(NAME)`.
 */
const UNEXPANDED =
  /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_.]*\}|\([A-Za-z_][A-Za-z0-9_.]*\))$/;

export function isUnexpandedReference(value: string): boolean {
  return UNEXPANDED.test(value.trim());
}

function read(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  if (!value) return null;
  if (isUnexpandedReference(value))
    throw new UnexpandedBitbucketTokenError(name, value);
  return value;
}

/**
 * Bearer wins when both are configured: an access token is the narrower,
 * recommended credential.
 */
export function resolveBitbucketAuth(
  env: NodeJS.ProcessEnv = process.env,
): BitbucketAuth {
  const token = read(env, "DROID_BITBUCKET_TOKEN");
  if (token) {
    return { header: `Bearer ${token}` };
  }
  const username = read(env, "DROID_BITBUCKET_USERNAME");
  const apiToken = read(env, "DROID_BITBUCKET_API_TOKEN");
  if (username && apiToken) {
    const encoded = Buffer.from(`${username}:${apiToken}`).toString("base64");
    return { header: `Basic ${encoded}` };
  }
  throw new MissingBitbucketCredentialsError();
}

/** Variables whose value is a secret (the username is not). */
const SECRET_ENV_VARS = [
  "DROID_BITBUCKET_TOKEN",
  "DROID_BITBUCKET_API_TOKEN",
  "BITBUCKET_STEP_OIDC_TOKEN",
] as const;

/**
 * Copy of `env` without any Bitbucket credential, for `droid exec`. CI
 * systems often keep the original secret under another name (Bamboo's
 * `bamboo_..._SECRET` that the template copies into DROID_BITBUCKET_TOKEN),
 * so any variable holding the same value goes too.
 */
export function withoutBitbucketCredentials(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const secrets = new Set(
    SECRET_ENV_VARS.map((name) => env[name]?.trim()).filter((v): v is string =>
      Boolean(v),
    ),
  );
  const out = { ...env };
  for (const name of BITBUCKET_CREDENTIAL_ENV_VARS) delete out[name];
  for (const [name, value] of Object.entries(out)) {
    if (value !== undefined && secrets.has(value.trim())) delete out[name];
  }
  return out;
}
