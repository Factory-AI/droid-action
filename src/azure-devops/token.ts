/**
 * Credentials for the Azure DevOps REST API.
 *
 * `AZURE_DEVOPS_PAT` wins when it carries a real value so a named service
 * account can author the comments; otherwise the job's
 * `$(System.AccessToken)` (mapped to `SYSTEM_ACCESSTOKEN`) posts as the
 * build service identity.
 */

import {
  AZURE_DEVOPS_CREDENTIAL_ENV_NAMES,
  secretValuesFromEnv,
} from "../utils/redact-credentials";

export type AzureDevopsAuth =
  | { kind: "bearer"; token: string }
  | { kind: "pat"; token: string };

export class MissingAzureDevopsTokenError extends Error {
  constructor() {
    super(
      "Missing Azure DevOps token. Map `SYSTEM_ACCESSTOKEN: $(System.AccessToken)` " +
        "in the review step's `env:` (the build service identity needs " +
        '"Contribute to pull requests" on the repository), or set a secret ' +
        "AZURE_DEVOPS_PAT variable with the Code (Read & write) scope.",
    );
    this.name = "MissingAzureDevopsTokenError";
  }
}

export class UnexpandedAzureDevopsTokenError extends Error {
  constructor(name: string, value: string) {
    super(
      `${name} was passed through as the literal string "${value}" instead of a token. ` +
        "Azure Pipelines leaves a `$(...)` macro unexpanded when the variable does not exist; " +
        "check the spelling of the `env:` mapping (it must be `$(System.AccessToken)`).",
    );
    this.name = "UnexpandedAzureDevopsTokenError";
  }
}

const UNEXPANDED_MACRO = /^\$\([^)]*\)$/;

/** Azure Pipelines hands a step `$(Name)` verbatim when Name is undefined. */
export function isUnexpandedMacro(value: string | undefined | null): boolean {
  return typeof value === "string" && UNEXPANDED_MACRO.test(value.trim());
}

export function setupAzureDevopsAuth(
  env: NodeJS.ProcessEnv = process.env,
): AzureDevopsAuth {
  const pat = env.AZURE_DEVOPS_PAT?.trim();
  // The shipped pipeline always maps AZURE_DEVOPS_PAT, so an unexpanded
  // macro just means the optional variable was never defined.
  if (pat && !isUnexpandedMacro(pat)) {
    return { kind: "pat", token: pat };
  }

  const systemToken = env.SYSTEM_ACCESSTOKEN?.trim();
  if (systemToken) {
    if (isUnexpandedMacro(systemToken)) {
      throw new UnexpandedAzureDevopsTokenError(
        "SYSTEM_ACCESSTOKEN",
        systemToken,
      );
    }
    return { kind: "bearer", token: systemToken };
  }

  throw new MissingAzureDevopsTokenError();
}

export function authorizationHeader(auth: AzureDevopsAuth): string {
  if (auth.kind === "bearer") {
    return `Bearer ${auth.token}`;
  }
  return `Basic ${Buffer.from(`:${auth.token}`).toString("base64")}`;
}

/**
 * Every credential value the job holds, for redaction. Each value also
 * appears in the Basic `Authorization` form (`base64(":" + PAT)`), which a
 * tool can print and which is as reusable as the PAT itself. Longest first,
 * so no secret is left partly redacted by a shorter one it contains.
 */
export function azureDevopsSecretValues(
  env: NodeJS.ProcessEnv = process.env,
  extraTokens: readonly string[] = [],
): string[] {
  const values = new Set<string>();
  for (const value of [
    ...secretValuesFromEnv(AZURE_DEVOPS_CREDENTIAL_ENV_NAMES, env),
    ...extraTokens,
  ]) {
    values.add(value);
    values.add(Buffer.from(`:${value}`).toString("base64"));
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Env vars that carry Azure DevOps credentials; never hand these to the model. */
export const AZURE_DEVOPS_TOKEN_ENV_VARS = [
  "SYSTEM_ACCESSTOKEN",
  "AZURE_DEVOPS_PAT",
  "AZURE_DEVOPS_EXT_PAT",
] as const;

export function withoutAzureDevopsTokens(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const rest = { ...env };
  for (const name of AZURE_DEVOPS_TOKEN_ENV_VARS) {
    delete rest[name];
  }
  return rest;
}
