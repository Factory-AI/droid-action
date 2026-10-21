import { describe, expect, it } from "bun:test";
import {
  BITBUCKET_TRACKING_MARKER,
  buildTrackingCommentBody,
  findOwnTrackingComment,
} from "../../src/bitbucket/operations/tracking-comment";

describe("buildTrackingCommentBody", () => {
  it("starts every state with the hidden marker and uses no raw HTML", () => {
    for (const state of ["running", "success", "failure"] as const) {
      const body = buildTrackingCommentBody({
        state,
        errorDetails: "boom",
        securityReviewRan: true,
        telemetry: { totalNumTurns: 2, pass1SessionId: "s1" },
      });
      expect(body.startsWith(`${BITBUCKET_TRACKING_MARKER}\n`)).toBe(true);
      // Bitbucket escapes HTML, so tags would render as literal text.
      expect(body).not.toMatch(/<\/?(details|summary|sub)>|<!--/);
    }
  });

  it("renders the running state with the build link and security flag", () => {
    expect(
      buildTrackingCommentBody({
        state: "running",
        pipelineUrl: "https://ci/1",
        securityReviewRan: true,
      }),
    ).toBe(
      [
        BITBUCKET_TRACKING_MARKER,
        "",
        "**Droid is reviewing this pull request...** ⏳",
        "",
        "Security review: enabled",
        "Build: https://ci/1",
        "",
      ].join("\n"),
    );
  });

  it("renders the final summary, counts, and telemetry", () => {
    const body = buildTrackingCommentBody({
      state: "success",
      review: {
        posted: 1,
        fallbackPosted: 2,
        failed: 1,
        skipped: 3,
        summaryBody: "Looks mostly fine.",
      },
      telemetry: {
        totalNumTurns: 12,
        totalDurationMs: 65_000,
        totalCostUsd: 0.5,
        pass1SessionId: "p1",
        pass2SessionId: "p2",
      },
    });
    expect(body).toContain("**Droid finished reviewing this pull request** ✅");
    expect(body).toContain("Looks mostly fine.");
    expect(body).toContain(
      "1 inline comment posted · 2 posted as regular comments (line outside the diff) · 1 could not be posted · 3 skipped",
    );
    expect(body).toMatch(/_12 turns · .+ · .+_/);
    expect(body).toContain("Droid sessions: pass 1 `p1`, pass 2 `p2`");
  });

  it("shows error details only on failure", () => {
    const failed = buildTrackingCommentBody({
      state: "failure",
      errorDetails: "pass 1 failed",
    });
    expect(failed).toContain("**Error details**\n\n```\npass 1 failed\n```");
    expect(
      buildTrackingCommentBody({
        state: "success",
        errorDetails: "pass 1 failed",
      }),
    ).not.toContain("pass 1 failed");
  });
});

describe("findOwnTrackingComment", () => {
  const body = buildTrackingCommentBody({ state: "running" });

  it("finds the top-level marker comment written by the job identity", () => {
    expect(
      findOwnTrackingComment(
        [
          { id: 1, body: "LGTM", parentId: null, authorId: "{me}" },
          { id: 2, body, parentId: null, authorId: "{ME}" },
        ],
        "{me}",
      )?.id,
    ).toBe(2);
  });

  it("ignores a marker comment written by someone else", () => {
    expect(
      findOwnTrackingComment(
        [{ id: 2, body, parentId: null, authorId: "mallory" }],
        "droid-bot",
      ),
    ).toBeUndefined();
  });

  it("reuses nothing when the job identity is unknown", () => {
    expect(
      findOwnTrackingComment(
        [{ id: 2, body, parentId: null, authorId: "droid-bot" }],
        null,
      ),
    ).toBeUndefined();
  });

  it("ignores replies and comments that only mention the marker inline", () => {
    expect(
      findOwnTrackingComment(
        [
          { id: 3, body, parentId: 2, authorId: "me" },
          {
            id: 4,
            body: `see ${BITBUCKET_TRACKING_MARKER} above`,
            parentId: null,
            authorId: "me",
          },
        ],
        "me",
      ),
    ).toBeUndefined();
  });
});
