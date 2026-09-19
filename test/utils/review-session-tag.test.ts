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
        runId: "987",
        runAttempt: "2",
      },
    });
  });

  it("omits run id and attempt when they are unavailable", () => {
    const tag = buildReviewSessionTag({
      pass: "validator",
      reviewType: "security",
      platform: "gitlab",
      repo: "group/sub/project",
      pr: 7,
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
    });

    const parsed = parseShellArgs(formatReviewSessionTagArg(tag));
    expect(parsed).toHaveLength(2);
    expect(JSON.parse(parsed[1] as string)).toEqual(tag);
  });
});

describe("githubReviewSessionTagArg", () => {
  const savedAttempt = process.env.GITHUB_RUN_ATTEMPT;

  beforeEach(() => {
    process.env.GITHUB_RUN_ATTEMPT = "3";
  });

  afterEach(() => {
    if (savedAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = savedAttempt;
  });

  it("derives repo, PR, run id and attempt from the GitHub context", () => {
    const fragment = githubReviewSessionTagArg({
      pass: "validator",
      runType: DroidRunType.SecurityReview,
      context: {
        runId: "1234567890",
        repository: { owner: "test-owner", repo: "test-repo" },
        entityNumber: 24,
      },
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
});
