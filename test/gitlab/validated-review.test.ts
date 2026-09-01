import { describe, expect, it } from "bun:test";
import {
  InvalidValidatedReviewError,
  parseValidatedReview,
} from "../../src/gitlab/data/validated-review";

function validated(results: unknown[], reviewSummary?: unknown): string {
  return JSON.stringify({
    version: 1,
    meta: { project: "g/p", mrIid: 7 },
    results,
    ...(reviewSummary === undefined ? {} : { reviewSummary }),
  });
}

const approved = (overrides: Record<string, unknown> = {}) => ({
  status: "approved",
  comment: {
    path: "src/x.ts",
    body: "[P1] Title\n\nBody.",
    line: 42,
    startLine: null,
    side: "RIGHT",
    commit_id: "sha",
    ...overrides,
  },
});

describe("parseValidatedReview", () => {
  it("returns approved comments in order", () => {
    const parsed = parseValidatedReview(
      validated([
        approved({ path: "a.ts", line: 1 }),
        { status: "rejected", candidate: { path: "b.ts" }, reason: "no" },
        approved({ path: "c.ts", line: 3 }),
      ]),
    );

    expect(parsed.approved.map((c) => c.path)).toEqual(["a.ts", "c.ts"]);
    expect(parsed.approvedCount).toBe(2);
    expect(parsed.rejectedCount).toBe(1);
    expect(parsed.skipped).toHaveLength(0);
  });

  it("treats any status other than approved as not postable", () => {
    const parsed = parseValidatedReview(
      validated([
        { status: "rejected", candidate: {} },
        { status: "needs-work", comment: { path: "a.ts", body: "b", line: 1 } },
        { comment: { path: "b.ts", body: "b", line: 1 } },
      ]),
    );
    expect(parsed.approved).toHaveLength(0);
    expect(parsed.rejectedCount).toBe(3);
  });

  it("extracts the review summary body", () => {
    const withSummary = parseValidatedReview(
      validated([], { status: "approved", body: "Looks good overall." }),
    );
    expect(withSummary.summaryBody).toBe("Looks good overall.");

    expect(parseValidatedReview(validated([])).summaryBody).toBeNull();
    expect(
      parseValidatedReview(validated([], { body: "   " })).summaryBody,
    ).toBeNull();
  });

  it("keeps a multi-line span only when it precedes the anchor", () => {
    const kept = parseValidatedReview(
      validated([approved({ line: 42, startLine: 40 })]),
    );
    expect(kept.approved[0]!.startLine).toBe(40);

    const dropped = parseValidatedReview(
      validated([approved({ line: 42, startLine: 42 })]),
    );
    expect(dropped.approved[0]!.startLine).toBeNull();
  });

  it("carries LEFT-side anchors through", () => {
    const parsed = parseValidatedReview(
      validated([
        approved({
          side: "LEFT",
          line: null,
          old_line: 12,
          old_path: "old.ts",
        }),
      ]),
    );
    expect(parsed.approved[0]).toMatchObject({
      side: "LEFT",
      old_line: 12,
      old_path: "old.ts",
    });
  });

  it("anchors a LEFT-side span on the old line", () => {
    const parsed = parseValidatedReview(
      validated([
        approved({ side: "LEFT", line: null, old_line: 19, startLine: 17 }),
      ]),
    );
    expect(parsed.approved[0]).toMatchObject({
      side: "LEFT",
      old_line: 19,
      startLine: 17,
    });

    const dropped = parseValidatedReview(
      validated([
        approved({ side: "LEFT", line: null, old_line: 19, startLine: 25 }),
      ]),
    );
    expect(dropped.approved[0]!.startLine).toBeNull();
  });

  it("normalizes sloppy model output instead of forwarding it", () => {
    const parsed = parseValidatedReview(
      validated([
        approved({
          line: 42.9,
          startLine: 40.2,
          old_path: "   ",
          side: "right",
        }),
      ]),
    );
    expect(parsed.approved[0]).toMatchObject({
      line: 42,
      startLine: 40,
      old_path: null,
      // Anything but the exact string "LEFT" anchors on the new side.
      side: "RIGHT",
    });
  });

  it("skips result entries that are not objects", () => {
    const parsed = parseValidatedReview(
      validated([null, "approved", ["approved"], 7]),
    );
    expect(parsed.approved).toHaveLength(0);
    expect(parsed.skipped).toHaveLength(4);
    expect(parsed.skipped[0]!.reason).toContain("not an object");
    expect(parsed.approvedCount).toBe(0);
    expect(parsed.rejectedCount).toBe(0);
  });

  it("skips approved entries that cannot be posted, counting them separately", () => {
    const parsed = parseValidatedReview(
      validated([
        { status: "approved" },
        approved({ line: null }),
        approved({ body: "" }),
        approved({ line: 0 }),
        approved({ side: "LEFT", line: null, old_line: null }),
      ]),
    );

    expect(parsed.approved).toHaveLength(0);
    expect(parsed.approvedCount).toBe(5);
    expect(parsed.skipped).toHaveLength(5);
    expect(parsed.skipped[0]!.reason).toContain("no `comment` object");
    expect(parsed.skipped[1]!.reason).toContain("line anchor");
    expect(parsed.skipped[2]!.reason).toContain("`path` or `body`");
    expect(parsed.skipped[4]!.reason).toContain("side=LEFT");
  });

  it("rejects files that are not a usable validated review", () => {
    expect(() => parseValidatedReview("not json")).toThrow(
      InvalidValidatedReviewError,
    );
    expect(() => parseValidatedReview("[]")).toThrow(
      "top level is not an object",
    );
    expect(() => parseValidatedReview("{}")).toThrow("missing `results` array");
    expect(() => parseValidatedReview(JSON.stringify({ results: {} }))).toThrow(
      "missing `results` array",
    );
  });

  it("never promotes a candidates-shaped file into postable comments", () => {
    // Pass 1 output has `comments`, not `results`; posting it unvalidated
    // would bypass the whole second pass.
    const candidates = JSON.stringify({
      version: 1,
      comments: [{ path: "a.ts", body: "b", line: 1 }],
    });
    expect(() => parseValidatedReview(candidates)).toThrow(
      "missing `results` array",
    );
  });
});
