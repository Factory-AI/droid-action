import { describe, expect, it } from "bun:test";
import {
  DROID_TRACKING_MARKER,
  buildTrackingNoteBody,
  findExistingTrackingNote,
} from "../../src/gitlab/operations/tracking-note";

describe("buildTrackingNoteBody", () => {
  it("includes the tracking marker in every state", () => {
    for (const state of ["running", "success", "failure"] as const) {
      const body = buildTrackingNoteBody({ state });
      expect(body).toContain(DROID_TRACKING_MARKER);
    }
  });

  it("renders pipeline + job links when provided", () => {
    const body = buildTrackingNoteBody({
      state: "running",
      pipelineUrl: "https://gitlab.com/p/-/pipelines/1",
      jobUrl: "https://gitlab.com/p/-/jobs/2",
    });
    expect(body).toContain("Pipeline: https://gitlab.com/p/-/pipelines/1");
    expect(body).toContain("Job log: https://gitlab.com/p/-/jobs/2");
  });

  it("renders security badge when securityReviewRan is true", () => {
    const body = buildTrackingNoteBody({
      state: "running",
      securityReviewRan: true,
    });
    expect(body).toContain("security%20review-enabled");
  });

  it("omits security badge when securityReviewRan is false", () => {
    const body = buildTrackingNoteBody({
      state: "running",
      securityReviewRan: false,
    });
    expect(body).not.toContain("security%20review-enabled");
  });

  it("embeds error details only on failure state", () => {
    const failure = buildTrackingNoteBody({
      state: "failure",
      errorDetails: "boom",
    });
    expect(failure).toContain("<details>");
    expect(failure).toContain("boom");

    const success = buildTrackingNoteBody({
      state: "success",
      errorDetails: "boom",
    });
    expect(success).not.toContain("<details>");
  });

  it("renders telemetry summary line when totals are provided", () => {
    const body = buildTrackingNoteBody({
      state: "success",
      telemetry: {
        totalNumTurns: 44,
        totalDurationMs: 700000,
        totalCostUsd: 0.42,
      },
    });
    expect(body).toContain("44 turns");
    expect(body).toContain("11m 40s");
    expect(body).toContain("$0.42");
  });

  it("includes session IDs in a collapsible block when provided", () => {
    const body = buildTrackingNoteBody({
      state: "success",
      telemetry: {
        pass1SessionId: "sess-1",
        pass2SessionId: "sess-2",
      },
    });
    expect(body).toContain("Droid session IDs");
    expect(body).toContain("`sess-1`");
    expect(body).toContain("`sess-2`");
  });

  it("renders the review summary and posted count from the post step", () => {
    const body = buildTrackingNoteBody({
      state: "success",
      review: {
        posted: 3,
        failed: 0,
        skipped: 0,
        summaryBody: "Three issues worth fixing before merge.",
      },
    });
    expect(body).toContain("Three issues worth fixing before merge.");
    expect(body).toContain("3 inline comments posted");
    expect(body).not.toContain("could not be anchored");
    expect(body).not.toContain("skipped");
  });

  it("surfaces unanchored and skipped counts only when non-zero", () => {
    const body = buildTrackingNoteBody({
      state: "success",
      review: { posted: 1, failed: 2, skipped: 1 },
    });
    expect(body).toContain("1 inline comment posted");
    expect(body).toContain("2 could not be anchored to the diff");
    expect(body).toContain("1 skipped");

    const empty = buildTrackingNoteBody({ state: "success", review: {} });
    expect(empty).not.toContain("inline comment");
  });

  it("omits telemetry block entirely when telemetry is missing or empty", () => {
    const none = buildTrackingNoteBody({ state: "success" });
    expect(none).not.toContain("turns");
    expect(none).not.toContain("Droid session IDs");

    const empty = buildTrackingNoteBody({
      state: "success",
      telemetry: {},
    });
    expect(empty).not.toContain("turns");
    expect(empty).not.toContain("Droid session IDs");
  });
});

describe("findExistingTrackingNote", () => {
  it("finds the note containing the droid marker", () => {
    const notes = [
      { id: 1, body: "regular comment" },
      { id: 2, body: `${DROID_TRACKING_MARKER}\nDroid is reviewing...` },
      { id: 3, body: "another comment" },
    ];
    expect(findExistingTrackingNote(notes)?.id).toBe(2);
  });

  it("returns undefined when no tracking note exists", () => {
    const notes = [{ id: 1, body: "regular comment" }];
    expect(findExistingTrackingNote(notes)).toBeUndefined();
  });
});
