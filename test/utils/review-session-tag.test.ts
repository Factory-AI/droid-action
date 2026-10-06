import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parse as parseShellArgs } from "shell-quote";
import { DroidRunType } from "../../src/run-type";
import {
  buildReviewSessionTag,
  formatReviewSessionTagArg,
  githubReviewSessionTagArg,
  REVIEW_SESSION_TAG_NAME,
  reviewTypeForRunType,
} from "../../src/utils/review-session-tag";

describe("buildReviewSessionTag", () => {
  it("keeps the legacy tag name and stringifies the PR number", () => {
    const tag = buildReviewSessionTag({
      pass: "candidates",
      reviewType: "code",
      platform: "github",
      repo: "acme/widgets",
      pr: 42,
      securityReview: false,
      runId: "987",
      runAttempt: "2",
    });

    expect(tag).toEqual({
      name: REVIEW_SESSION_TAG_NAME,
      metadata: {
        pass: "candidates",
        reviewType: "code",
        platform: "github",
        repo: "acme/widgets",
        pr: "42",
        securityReview: "false",
        runId: "987",
        runAttempt: "2",
      },
    });
  });

  it("records the security review flag on code reviews only", () => {
    const input = {
      pass: "candidates",
      platform: "github",
      repo: "acme/widgets",
      pr: 42,
      securityReview: true,
    } as const;

    expect(
      buildReviewSessionTag({ ...input, reviewType: "code" }).metadata
        .securityReview,
    ).toBe("true");
    expect(
      "securityReview" in
        buildReviewSessionTag({ ...input, reviewType: "security" }).metadata,
    ).toBe(false);
  });

  it("omits run id and attempt when they are unavailable", () => {
    const tag = buildReviewSessionTag({
      pass: "validator",
      reviewType: "security",
      platform: "gitlab",
      repo: "group/sub/project",
      pr: 7,
      securityReview: false,
      runId: null,
      runAttempt: undefined,
    });

    expect(tag.metadata).toEqual({
      pass: "validator",
      reviewType: "security",
      platform: "gitlab",
      repo: "group/sub/project",
      pr: "7",
    });
    expect("runId" in tag.metadata).toBe(false);
    expect("runAttempt" in tag.metadata).toBe(false);
  });
});

describe("reviewTypeForRunType", () => {
  it.each([
    [DroidRunType.SecurityReview, "security"],
    [DroidRunType.Review, "code"],
    [DroidRunType.Default, "code"],
    [null, "code"],
    [undefined, "code"],
  ] as const)("maps %s to %s", (runType, expected) => {
    expect(reviewTypeForRunType(runType)).toBe(expected);
  });
});

describe("formatReviewSessionTagArg", () => {
  it("round-trips through the shell parser as a single --tag value", () => {
    const tag = buildReviewSessionTag({
      pass: "candidates",
      reviewType: "code",
      platform: "github",
      repo: "acme/widgets",
      pr: 42,
      securityReview: true,
      runId: "987",
    });

    const fragment = formatReviewSessionTagArg(tag);
    const parsed = parseShellArgs(
      `--enabled-tools "Read,Grep" ${fragment} --model "gpt-5"`,
    );

    expect(parsed).toEqual([
      "--enabled-tools",
      "Read,Grep",
      "--tag",
      JSON.stringify(tag),
      "--model",
      "gpt-5",
    ]);
    expect(JSON.parse(parsed[3] as string)).toEqual(tag);
  });

  it("survives a repo name containing a single quote", () => {
    const tag = buildReviewSessionTag({
      pass: "candidates",
      reviewType: "code",
      platform: "gitlab",
      repo: "group/it's-a-repo",
      pr: 1,
      securityReview: false,
    });

    const parsed = parseShellArgs(formatReviewSessionTagArg(tag));
    expect(parsed).toHaveLength(2);
    expect(JSON.parse(parsed[1] as string)).toEqual(tag);
  });
});

describe("githubReviewSessionTagArg", () => {
  const savedAttempt = process.env.GITHUB_RUN_ATTEMPT;
  const savedSecurityReviewEnabled = process.env.SECURITY_REVIEW_ENABLED;
  const context = {
    runId: "1234567890",
    repository: { owner: "test-owner", repo: "test-repo" },
    entityNumber: 24,
  };

  beforeEach(() => {
    process.env.GITHUB_RUN_ATTEMPT = "3";
    delete process.env.SECURITY_REVIEW_ENABLED;
  });

  afterEach(() => {
    if (savedAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = savedAttempt;
    if (savedSecurityReviewEnabled === undefined)
      delete process.env.SECURITY_REVIEW_ENABLED;
    else process.env.SECURITY_REVIEW_ENABLED = savedSecurityReviewEnabled;
  });

  function metadataOf(fragment: string): unknown {
    const parsed = parseShellArgs(fragment);
    expect(parsed[0]).toBe("--tag");
    return (JSON.parse(parsed[1] as string) as { metadata: unknown }).metadata;
  }

  it("derives repo, PR, run id and attempt from the GitHub context", () => {
    const fragment = githubReviewSessionTagArg({
      pass: "validator",
      runType: DroidRunType.SecurityReview,
      context,
    });

    const parsed = parseShellArgs(fragment);
    expect(parsed[0]).toBe("--tag");
    expect(JSON.parse(parsed[1] as string)).toEqual({
      name: "code-review",
      metadata: {
        pass: "validator",
        reviewType: "security",
        platform: "github",
        repo: "test-owner/test-repo",
        pr: "24",
        runId: "1234567890",
        runAttempt: "3",
      },
    });
  });

  it("reads the security review flag from SECURITY_REVIEW_ENABLED", () => {
    const args = {
      pass: "candidates",
      runType: DroidRunType.Review,
      context,
    } as const;

    expect(metadataOf(githubReviewSessionTagArg(args))).toMatchObject({
      reviewType: "code",
      securityReview: "false",
    });

    process.env.SECURITY_REVIEW_ENABLED = "true";
    expect(metadataOf(githubReviewSessionTagArg(args))).toMatchObject({
      reviewType: "code",
      securityReview: "true",
    });
  });
});
