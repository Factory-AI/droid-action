#!/usr/bin/env bun

export class MissingGitlabTokenError extends Error {
  constructor() {
    super(
      "Missing GITLAB_TOKEN. Set a GitLab Project or Group access token with `api` scope as a masked CI/CD variable named GITLAB_TOKEN.",
    );
    this.name = "MissingGitlabTokenError";
  }
}

export class UnexpandedGitlabTokenError extends Error {
  constructor(value: string) {
    super(
      `GITLAB_TOKEN was passed through as the literal string "${value}" instead of a token value. ` +
        "GitLab leaves a variable unexpanded when a job declares it as a reference to itself " +
        "(`GITLAB_TOKEN: $GITLAB_TOKEN`). Remove that mapping and let the job inherit the " +
        "project or group CI/CD variable, or map a differently named variable instead.",
    );
    this.name = "UnexpandedGitlabTokenError";
  }
}

export function setupGitlabToken(): string {
  const token = process.env.GITLAB_TOKEN || process.env.OVERRIDE_GITLAB_TOKEN;

  if (!token) {
    throw new MissingGitlabTokenError();
  }

  // GitLab hands the job `$SOME_VAR` verbatim when it cannot expand the
  // reference, which would otherwise surface as an opaque 401 on first call.
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(token.trim())) {
    throw new UnexpandedGitlabTokenError(token.trim());
  }

  return token;
}
