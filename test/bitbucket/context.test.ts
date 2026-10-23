import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  BitbucketContextError,
  parseBitbucketContext,
  parsePullRequestUrl,
} from "../../src/bitbucket/context";

// Variables Bitbucket Pipelines sets on a `pull-requests:` step.
const PIPELINES_PR_ENV = {
  CI: "true",
  BITBUCKET_WORKSPACE: "acme",
  BITBUCKET_REPO_SLUG: "web-app",
  BITBUCKET_REPO_FULL_NAME: "acme/web-app",
  BITBUCKET_PR_ID: "42",
  BITBUCKET_PR_DESTINATION_BRANCH: "main",
  BITBUCKET_BRANCH: "feature/login",
  BITBUCKET_COMMIT: "f".repeat(40),
  BITBUCKET_BUILD_NUMBER: "117",
  BITBUCKET_PIPELINE_UUID: "{11111111-2222-3333-4444-555555555555}",
  BITBUCKET_STEP_UUID: "{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}",
  BITBUCKET_GIT_HTTP_ORIGIN: "http://bitbucket.org/acme/web-app",
  BITBUCKET_CLONE_DIR: "/opt/atlassian/pipelines/agent/build",
};

// Variables Jenkins' Bitbucket Branch Source plugin sets on a PR build.
const JENKINS_PR_ENV = {
  BRANCH_NAME: "PR-12",
  CHANGE_ID: "12",
  CHANGE_URL:
    "https://git.example.com/bitbucket/projects/PLAT/repos/billing/pull-requests/12",
  CHANGE_TARGET: "main",
  CHANGE_BRANCH: "feature/tax",
  BUILD_URL: "https://jenkins.example.com/job/billing/job/PR-12/3/",
  BUILD_TAG: "jenkins-billing-PR-12-3",
  GIT_COMMIT: "c".repeat(40),
};

afterEach(() => {
  (console.warn as { mockRestore?: () => void }).mockRestore?.();
});

describe("parseBitbucketContext: Bitbucket Cloud (Pipelines)", () => {
  it("reads the pull request and builds the step URL", () => {
    const ctx = parseBitbucketContext(PIPELINES_PR_ENV);
    expect(ctx).toMatchObject({
      variant: "cloud",
      apiUrl: "https://api.bitbucket.org/2.0",
      workspace: "acme",
      repoSlug: "web-app",
      repoFullName: "acme/web-app",
      prId: 42,
      commitSha: "f".repeat(40),
      runId: "{11111111-2222-3333-4444-555555555555}",
      buildUrl:
        "http://bitbucket.org/acme/web-app/pipelines/results/117/steps/%7Baaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee%7D",
    });
  });

  it("has no PR id on a branch pipeline", () => {
    const { BITBUCKET_PR_ID: _, ...branchEnv } = PIPELINES_PR_ENV;
    expect(parseBitbucketContext(branchEnv).prId).toBeNull();
  });

  it("applies input defaults", () => {
    expect(parseBitbucketContext(PIPELINES_PR_ENV).inputs).toEqual({
      automaticReview: true,
      automaticSecurityReview: false,
      reviewDepth: "deep",
      reviewModel: "",
      reasoningEffort: "",
      includeSuggestions: true,
      reviewDrafts: false,
      buildStatus: false,
      settings: "",
    });
  });

  it("reads input overrides", () => {
    const ctx = parseBitbucketContext({
      ...PIPELINES_PR_ENV,
      AUTOMATIC_REVIEW: "false",
      AUTOMATIC_SECURITY_REVIEW: "TRUE",
      REVIEW_DEPTH: "shallow",
      REVIEW_MODEL: "anthropic-latest-balanced",
      REASONING_EFFORT: "high",
      INCLUDE_SUGGESTIONS: "false",
      REVIEW_DRAFTS: "true",
      BUILD_STATUS: "true",
      DROID_SETTINGS: '{"a":1}',
    });
    expect(ctx.inputs).toEqual({
      automaticReview: false,
      automaticSecurityReview: true,
      reviewDepth: "shallow",
      reviewModel: "anthropic-latest-balanced",
      reasoningEffort: "high",
      includeSuggestions: false,
      reviewDrafts: true,
      buildStatus: true,
      settings: '{"a":1}',
    });
  });

  it("prefers DROID_BUILD_URL and honors BITBUCKET_API_URL", () => {
    const ctx = parseBitbucketContext({
      ...PIPELINES_PR_ENV,
      DROID_BUILD_URL: "https://ci.example.com/1",
      BITBUCKET_API_URL: "http://localhost:9999/2.0/",
    });
    expect(ctx.buildUrl).toBe("https://ci.example.com/1");
    expect(ctx.variant === "cloud" && ctx.apiUrl).toBe(
      "http://localhost:9999/2.0",
    );
  });

  it("supports Jenkins against Bitbucket Cloud through CHANGE_URL", () => {
    const ctx = parseBitbucketContext({
      CHANGE_ID: "5",
      CHANGE_URL: "https://bitbucket.org/acme/api/pull-requests/5",
      BUILD_URL: "https://jenkins/job/5",
    });
    expect(ctx).toMatchObject({
      variant: "cloud",
      workspace: "acme",
      repoSlug: "api",
      prId: 5,
      buildUrl: "https://jenkins/job/5",
    });
  });
});

describe("parseBitbucketContext: Bitbucket Data Center", () => {
  it("resolves everything from Jenkins Bitbucket Branch Source variables", () => {
    const ctx = parseBitbucketContext(JENKINS_PR_ENV);
    expect(ctx).toMatchObject({
      variant: "datacenter",
      serverUrl: "https://git.example.com/bitbucket",
      projectKey: "PLAT",
      repoSlug: "billing",
      repoFullName: "PLAT/billing",
      prId: 12,
      commitSha: "c".repeat(40),
      buildUrl: "https://jenkins.example.com/job/billing/job/PR-12/3/",
      runId: "jenkins-billing-PR-12-3",
    });
  });

  it("lets explicit variables override the parsed URL, warning about a host mismatch", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const ctx = parseBitbucketContext({
      ...JENKINS_PR_ENV,
      BITBUCKET_SERVER_URL: "http://internal-bitbucket:7990/",
      BITBUCKET_PR_ID: "13",
    });
    expect(ctx).toMatchObject({
      variant: "datacenter",
      serverUrl: "http://internal-bitbucket:7990",
      projectKey: "PLAT",
      prId: 13,
    });
    expect(warn.mock.calls.flat().join(" ")).toContain(
      "points at git.example.com but BITBUCKET_SERVER_URL is internal-bitbucket",
    );
  });

  it("does not warn when the URL and BITBUCKET_SERVER_URL name the same host", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    parseBitbucketContext({
      ...JENKINS_PR_ENV,
      BITBUCKET_SERVER_URL: "https://git.example.com/bitbucket",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["a GitHub pull request", "https://github.com/acme/billing/pull/12"],
    ["missing", undefined],
  ])("ignores Jenkins CHANGE_ID when CHANGE_URL is %s", (_label, changeUrl) => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const env: Record<string, string> = {
      BITBUCKET_SERVER_URL: "https://bb.example.com",
      BITBUCKET_PROJECT_KEY: "PLAT",
      BITBUCKET_REPO_SLUG: "billing",
      CHANGE_ID: "12",
    };
    if (changeUrl) env.CHANGE_URL = changeUrl;
    expect(parseBitbucketContext(env).prId).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toContain(
      "ignoring Jenkins CHANGE_ID=12",
    );
  });

  it("resolves Bamboo pull request builds", () => {
    const ctx = parseBitbucketContext({
      BITBUCKET_VARIANT: "datacenter",
      BITBUCKET_SERVER_URL: "https://bb.example.com",
      BITBUCKET_PROJECT_KEY: "PROJ",
      BITBUCKET_REPO_SLUG: "repo",
      bamboo_repository_pr_key: "77",
      bamboo_resultsUrl: "https://bamboo.example.com/browse/PROJ-PLAN0-3",
      bamboo_buildResultKey: "PROJ-PLAN0-3",
      bamboo_planRepository_revision: "d".repeat(40),
    });
    expect(ctx).toMatchObject({
      variant: "datacenter",
      prId: 77,
      buildUrl: "https://bamboo.example.com/browse/PROJ-PLAN0-3",
      runId: "PROJ-PLAN0-3",
      commitSha: "d".repeat(40),
    });
  });

  it("accepts PR-prefixed ids", () => {
    const ctx = parseBitbucketContext({
      BITBUCKET_SERVER_URL: "https://bb",
      BITBUCKET_PROJECT_KEY: "P",
      BITBUCKET_REPO_SLUG: "r",
      BITBUCKET_PR_ID: "PR-9",
    });
    expect(ctx.prId).toBe(9);
  });

  it("names every missing Data Center variable", () => {
    expect(() =>
      parseBitbucketContext({
        BITBUCKET_VARIANT: "datacenter",
        BITBUCKET_PR_ID: "1",
      }),
    ).toThrow(
      "Missing Bitbucket Data Center context: BITBUCKET_SERVER_URL, BITBUCKET_PROJECT_KEY, BITBUCKET_REPO_SLUG.",
    );
  });

  it("rejects a non-numeric PR id", () => {
    expect(() =>
      parseBitbucketContext({
        BITBUCKET_SERVER_URL: "https://bb",
        BITBUCKET_PROJECT_KEY: "P",
        BITBUCKET_REPO_SLUG: "r",
        BITBUCKET_PR_ID: "abc",
      }),
    ).toThrow(BitbucketContextError);
  });
});

describe("variant detection", () => {
  it("fails with setup guidance when nothing identifies the variant", () => {
    expect(() => parseBitbucketContext({})).toThrow(
      /Could not determine the Bitbucket variant/,
    );
  });

  it("rejects an unknown BITBUCKET_VARIANT", () => {
    expect(() =>
      parseBitbucketContext({
        ...PIPELINES_PR_ENV,
        BITBUCKET_VARIANT: "gitlab",
      }),
    ).toThrow(/must be "cloud" or "datacenter"/);
  });

  it("requires workspace and slug for Cloud", () => {
    expect(() =>
      parseBitbucketContext({
        BITBUCKET_VARIANT: "cloud",
        BITBUCKET_PR_ID: "1",
      }),
    ).toThrow(/Missing Bitbucket Cloud context/);
  });
});

describe("parsePullRequestUrl", () => {
  it("parses Data Center URLs with and without a context path or suffix", () => {
    expect(
      parsePullRequestUrl(
        "https://bb.example.com/projects/PROJ/repos/my-repo/pull-requests/3/overview",
      ),
    ).toEqual({
      variant: "datacenter",
      serverUrl: "https://bb.example.com",
      projectKey: "PROJ",
      repoSlug: "my-repo",
      prId: 3,
    });
    expect(
      parsePullRequestUrl(
        "http://host:7990/bb/projects/~ADA/repos/r/pull-requests/1",
      ),
    ).toMatchObject({ serverUrl: "http://host:7990/bb", projectKey: "~ADA" });
  });

  it("parses Cloud URLs and rejects anything else", () => {
    expect(
      parsePullRequestUrl("https://bitbucket.org/ws/repo/pull-requests/8/diff"),
    ).toEqual({ variant: "cloud", workspace: "ws", repoSlug: "repo", prId: 8 });
    expect(parsePullRequestUrl("https://github.com/o/r/pull/1")).toBeNull();
  });
});
