#!/usr/bin/env bun

export class MissingGitlabTokenError extends Error {
  constructor() {
    super(
      "Missing GITLAB_TOKEN. Set a GitLab Project or Group access token with `api` scope as a masked CI/CD variable named GITLAB_TOKEN.",
    );
    this.name = "MissingGitlabTokenError";
  }
}

export function setupGitlabToken(): string {
  const token = process.env.GITLAB_TOKEN || process.env.OVERRIDE_GITLAB_TOKEN;

  if (!token) {
    throw new MissingGitlabTokenError();
  }

  return token;
}
