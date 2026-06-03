import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  setupGitlabToken,
  MissingGitlabTokenError,
} from "../../src/gitlab/token";

const KEYS = ["GITLAB_TOKEN", "OVERRIDE_GITLAB_TOKEN", "CI_JOB_TOKEN"];

describe("setupGitlabToken", () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] !== undefined) {
        process.env[k] = original[k];
      } else {
        delete process.env[k];
      }
    }
  });

  it("prefers GITLAB_TOKEN", () => {
    process.env.GITLAB_TOKEN = "glpat-primary";
    process.env.OVERRIDE_GITLAB_TOKEN = "glpat-override";
    process.env.CI_JOB_TOKEN = "ci-job-token";
    expect(setupGitlabToken()).toBe("glpat-primary");
  });

  it("falls back to OVERRIDE_GITLAB_TOKEN", () => {
    process.env.OVERRIDE_GITLAB_TOKEN = "glpat-override";
    process.env.CI_JOB_TOKEN = "ci-job-token";
    expect(setupGitlabToken()).toBe("glpat-override");
  });

  it("does NOT fall back to CI_JOB_TOKEN (its scopes are insufficient for notes/discussions)", () => {
    process.env.CI_JOB_TOKEN = "ci-job-token";
    expect(() => setupGitlabToken()).toThrow(MissingGitlabTokenError);
  });

  it("throws MissingGitlabTokenError when nothing is set", () => {
    expect(() => setupGitlabToken()).toThrow(MissingGitlabTokenError);
  });
});
