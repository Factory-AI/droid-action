import { describe, expect, it } from "bun:test";
import {
  enrichReviewSummary,
  suggestedReviewersFromCodeowners,
} from "../../../src/core/review/validated/metadata";

describe("CODEOWNERS reviewer suggestions", () => {
  it("honors ordered rules, nested paths, teams, and explicit unowned overrides", () => {
    const content =
      "* @general\n/src/ @org/backend\n/src/private/ @security\n/src/private/public.ts\n*.md @docs\n";
    expect(
      suggestedReviewersFromCodeowners(content, [
        "README.md",
        "src/a.ts",
        "src/private/key.ts",
        "src/private/public.ts",
      ]),
    ).toEqual(["docs", "org/backend", "security"]);
    expect(
      suggestedReviewersFromCodeowners(content, ["src/private/public.ts"]),
    ).toEqual([]);
    expect(
      suggestedReviewersFromCodeowners("/src/ @root\n", ["nested/src/a.ts"]),
    ).toEqual([]);
  });
  it("handles basename patterns, root files, comments and escaped spaces", () => {
    expect(
      suggestedReviewersFromCodeowners(
        "*.ts @typescript # comment\n/docs/with\\ space.md @writer",
        ["index.ts", "nested/index.ts", "docs/with space.md"],
      ),
    ).toEqual(["typescript", "writer"]);
  });
  it("omits unavailable owners and unsupported negation or character ranges", () => {
    expect(
      suggestedReviewersFromCodeowners(
        "* @known @unknown\n!secret @bad\n[ab].ts @bad",
        ["a.ts"],
        ["known"],
      ),
    ).toEqual(["known"]);
    expect(
      suggestedReviewersFromCodeowners("* @known", ["../outside.ts"]),
    ).toEqual([]);
  });
});
describe("deterministic review metadata", () => {
  const input = {
    changedPaths: ["src/a.ts", "dist/a.js"],
    title: "Handle the retry failure",
    description: "Fixes #123. Adds a regression test for reconnect failures.",
    ignoredPaths: [{ path: "dist/a.js", reason: "generated" }],
  };
  it("overrides model guesses with actual file counts, settings, and base CODEOWNERS", () => {
    const summary = enrichReviewSummary(
      {
        filesReviewed: 999,
        suggestedReviewers: ["invented"],
        effort: { score: 3 },
        preMergeChecks: [{ name: "guessed", passed: true }],
      },
      {
        ...input,
        codeowners: "/src/ @org/backend",
        suggestReviewers: true,
        preMergeChecks: ["title", "description", "linked_issue"],
        security: {
          enabled: true,
          threshold: "high",
          blockOnCritical: true,
          blockOnHigh: false,
        },
      },
    );
    expect(summary.filesReviewed).toBe(1);
    expect(summary.filesSkipped).toEqual(input.ignoredPaths);
    expect(summary.suggestedReviewers).toEqual(["org/backend"]);
    expect(summary.effort).toBeUndefined();
    expect(summary.preMergeChecks?.map((check) => check.passed)).toEqual([
      true,
      true,
      true,
    ]);
    expect(summary.security?.threshold).toBe("high");
  });
  it("keeps optional metadata opt-in and does not trust model pre-merge results", () => {
    const summary = enrichReviewSummary(
      {
        effort: { score: 3 },
        suggestedReviewers: ["invented"],
        preMergeChecks: [{ name: "invented", passed: true }],
      },
      input,
    );
    expect(summary.effort).toBeUndefined();
    expect(summary.suggestedReviewers).toBeUndefined();
    expect(summary.preMergeChecks).toBeUndefined();
    const enabled = enrichReviewSummary(
      { effort: { score: 3 } },
      {
        ...input,
        includeEffort: true,
        title: "WIP",
        description: "<!-- Fixes #123 -->",
        preMergeChecks: ["title", "description", "linked_issue"],
      },
    );
    expect(enabled.effort?.score).toBe(3);
    expect(enabled.preMergeChecks?.every((check) => !check.passed)).toBe(true);
  });
});
