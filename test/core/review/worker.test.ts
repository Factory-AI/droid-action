import { describe, expect, it } from "bun:test";
import {
  REVIEW_SECONDS,
  buildReviewInput,
  modelFallbackNote,
  reviewOutcome,
} from "../../../src/core/review/worker";
import type { ReviewPromptSettings } from "../../../src/core/review/prompts/types";
import { normalizeFinding } from "../../../src/core/review/validated/finding";
import type { ReviewFinding } from "../../../src/core/review/validated/types";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const REVIEWED = "c".repeat(40);

const SETTINGS: ReviewPromptSettings = {
  depth: "deep",
  diagram: "auto",
  effort: true,
  suggestReviewers: false,
  preMergeChecks: ["title"],
  ignorePaths: ["dist/**"],
  severityThreshold: "P2",
  securitySeverityThreshold: "medium",
  securityBlockOnCritical: true,
  securityBlockOnHigh: false,
};

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    ...normalizeFinding({
      id: "f1",
      severity: "P1",
      title: "Known issue",
      path: "src/a.ts",
      line: 3,
      body: "Known issue",
    }),
    ...overrides,
  };
}

function inputFor(
  overrides: Partial<Parameters<typeof buildReviewInput>[0]> = {},
) {
  return buildReviewInput({
    owner: "acme",
    repo: "app",
    prNumber: 7,
    runId: "77",
    runAttempt: "2",
    base: BASE,
    head: HEAD,
    pullRequest: {
      baseRefName: "main",
      headRefName: "feature",
      isFork: true,
      title: "Add the thing",
      body: "Why it is added",
    },
    comments: { issueComments: [{ id: 1 }], reviewComments: [] },
    reviewedHeadFetched: false,
    incremental: false,
    findings: [],
    securityOnly: false,
    settings: SETTINGS,
    env: {},
    ...overrides,
  });
}

describe("buildReviewInput", () => {
  it("is the pull request, the run, and what the workflow set, under the worker's names", () => {
    expect(
      inputFor({
        focus: " the migration ",
        env: {
          REVIEW_MODEL: " model-a ",
          REASONING_EFFORT: "high",
          INCLUDE_SUGGESTIONS: "false",
          SECURITY_REVIEW_ENABLED: "true",
        },
      }),
    ).toEqual({
      repo: "acme/app",
      prNumber: 7,
      platform: "github",
      runId: "77",
      runAttempt: "2",
      base: BASE,
      head: HEAD,
      baseRef: "main",
      headRef: "feature",
      title: "Add the thing",
      body: "Why it is added",
      comments: JSON.stringify(
        { issueComments: [{ id: 1 }], reviewComments: [] },
        null,
        2,
      ),
      fork: true,
      suggestions: false,
      security: true,
      focus: "the migration",
      settings: SETTINGS,
      model: "model-a",
      reasoningEffort: "high",
      seconds: REVIEW_SECONDS,
    });
  });

  it("leaves out what the workflow did not set, so the judge's preset decides", () => {
    const input = inputFor({ runId: undefined, runAttempt: undefined });

    expect(input.suggestions).toBe(true);
    expect(input.security).toBe(false);
    for (const key of [
      "runId",
      "runAttempt",
      "focus",
      "model",
      "reasoningEffort",
      "prior",
    ]) {
      expect(input).not.toHaveProperty(key);
    }
  });

  it("redacts a credential from every text a pass is shown", () => {
    const token = `ghs_${"A1b2".repeat(9)}`;
    const input = inputFor({
      pullRequest: {
        baseRefName: "main",
        headRefName: "feature",
        isFork: false,
        title: `title ${token}`,
        body: `body ${token}`,
      },
      comments: {
        issueComments: [{ body: `comment ${token}` }],
        reviewComments: [],
      },
      focus: `focus ${token}`,
    });

    expect(JSON.stringify(input)).not.toContain(token);
    expect(input.title).toStartWith("title ");
    expect(input.focus).toStartWith("focus ");
  });

  it("runs a security-only review on the security model, or else the review model", () => {
    const env = { REVIEW_MODEL: "review-model", SECURITY_MODEL: "sec-model" };

    expect(inputFor({ securityOnly: true, env }).model).toBe("sec-model");
    expect(inputFor({ securityOnly: false, env }).model).toBe("review-model");
    expect(
      inputFor({ securityOnly: true, env: { REVIEW_MODEL: "review-model" } })
        .model,
    ).toBe("review-model");
  });

  it("shows the findings still open, once each, with a renamed file's old path", () => {
    const input = inputFor({
      reviewedHead: REVIEWED,
      reviewedHeadFetched: true,
      incremental: true,
      findings: [
        finding({ id: "open", title: "First copy" }),
        finding({ id: "open", title: "Last copy" }),
        finding({ id: "renamed", side: "LEFT", oldPath: "src/old.ts" }),
        finding({ id: "fixed", state: "resolved" }),
        finding({ id: "dismissed", state: "dismissed" }),
      ],
    });

    expect(input.prior?.reviewed).toEqual({
      head: REVIEWED,
      incremental: true,
    });
    expect(
      input.prior?.findings.map(({ id, title, old_path }) => ({
        id,
        title,
        old_path,
      })),
    ).toEqual([
      { id: "open", title: "Last copy", old_path: undefined },
      { id: "renamed", title: "Known issue", old_path: "src/old.ts" },
    ]);
  });

  it("names no reviewed head the checkout does not hold, and still shows the open findings", () => {
    const input = inputFor({
      reviewedHead: REVIEWED,
      reviewedHeadFetched: false,
      incremental: true,
      findings: [finding()],
    });

    expect(input.prior).toEqual({ findings: [finding()] });
  });
});

const revision = { base: BASE, head: HEAD };
const prepared = { base: BASE, head: HEAD };
const started = { id: "s1", model: "model-a", reasoningEffort: "high" };

describe("reviewOutcome", () => {
  it("hands on the answer with the model and effort the first session reported", () => {
    const answer = { results: [], reviewSummary: { body: "Fine." } };

    expect(
      reviewOutcome(
        {
          status: "answered",
          revision,
          sessions: [
            { ...started, status: "answered" },
            { id: "s2", model: "model-b", status: "answered" },
          ],
          answer,
        },
        prepared,
      ),
    ).toEqual({
      status: "answered",
      model: "model-a",
      reasoningEffort: "high",
      answer,
    });
  });

  it.each([
    ["head", { base: BASE, head: REVIEWED }],
    ["base", { base: REVIEWED, head: HEAD }],
  ])(
    "refuses an answer about another %s than the one prepared",
    (_name, other) => {
      expect(() =>
        reviewOutcome(
          {
            status: "answered",
            revision: other,
            sessions: [{ ...started, status: "answered" }],
            answer: {},
          },
          prepared,
        ),
      ).toThrow("The review worker's report is not about the prepared commits");
    },
  );

  it("says why the commits could not be pinned", () => {
    expect(
      reviewOutcome(
        { status: "unpinned", problem: { kind: "unresolved", ref: HEAD } },
        prepared,
      ),
    ).toEqual({
      status: "unpinned",
      error: `The pull request's commits could not be pinned (\`unresolved: ${HEAD}\`).`,
    });
    expect(
      reviewOutcome(
        { status: "unpinned", problem: { kind: "shallow" } },
        prepared,
      ),
    ).toMatchObject({
      error: "The pull request's commits could not be pinned (`shallow`).",
    });
  });

  it("names the pass that ended the review, and how", () => {
    expect(
      reviewOutcome(
        {
          status: "failed",
          problem: "start",
          revision,
          sessions: [{ status: "failed", problem: "start" }],
        },
        prepared,
      ),
    ).toEqual({
      status: "failed",
      error: "The candidates pass could not run (`start`).",
    });
    expect(
      reviewOutcome(
        {
          status: "interrupted",
          by: "deadline",
          revision,
          sessions: [
            { ...started, status: "answered" },
            { id: "s2", model: "model-a", status: "interrupted" },
          ],
        },
        prepared,
      ),
    ).toEqual({
      status: "interrupted",
      model: "model-a",
      reasoningEffort: "high",
      error: "The validator pass was stopped (`deadline`).",
    });
  });

  it("names the rules an answer broke, never the answer, and at most ten", () => {
    const issues = Array.from({ length: 12 }, (_, index) => ({
      path: ["comments", index, "line"],
      code: "invalid_type",
    }));

    const outcome = reviewOutcome(
      {
        status: "invalid",
        revision,
        sessions: [{ id: "s1", model: "model-a", status: "invalid", issues }],
      },
      prepared,
    );

    expect(outcome).toEqual({
      status: "invalid",
      model: "model-a",
      error:
        "The candidates pass's answer broke its contract: " +
        Array.from(
          { length: 10 },
          (_, index) => `comments.${index}.line: invalid_type`,
        ).join(", ") +
        ".",
    });
  });
});

describe("modelFallbackNote", () => {
  it("is silent when the model the workflow named is the one that ran", () => {
    expect(
      modelFallbackNote({ asked: "m", ran: "m", securityOnly: false }),
    ).toBeUndefined();
    expect(
      modelFallbackNote({ ran: "m", securityOnly: false }),
    ).toBeUndefined();
    expect(
      modelFallbackNote({ asked: "m", securityOnly: false }),
    ).toBeUndefined();
  });

  it("is silent for a tier alias, which always resolves to another name", () => {
    expect(
      modelFallbackNote({
        asked: "claude-latest-premium",
        ran: "claude-opus-4-1",
        securityOnly: false,
      }),
    ).toBeUndefined();
  });

  it("names both models and the input to change", () => {
    const note = modelFallbackNote({
      asked: "model-a",
      ran: "model-b",
      securityOnly: false,
    });
    expect(note).toStartWith(
      "The code review ran on `model-b`, not the `model-a` the workflow asked for.",
    );
    expect(note).toContain("Remove the `review_model` input");

    expect(
      modelFallbackNote({
        asked: "model-a",
        ran: "model-b",
        securityOnly: true,
      }),
    ).toContain("Remove the `security_model` or `review_model` input");
  });
});
