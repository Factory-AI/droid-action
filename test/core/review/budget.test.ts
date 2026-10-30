import { describe, expect, it } from "bun:test";
import {
  MAX_INLINE_OUTPUT_BYTES,
  MAX_REVIEW_OUTPUT_BYTES,
  ReviewOutputBudgetError,
  outputBytes,
  renderCheckRun,
  renderInlineComment,
  renderReviewBody,
  renderReviewSummary,
  renderReviewStateNote,
  renderSecurityReport,
  renderStepSummary,
  validateRenderedMarkdown,
  type ReviewRenderInput,
} from "../../../src/core/review/render";
import { normalizeFinding } from "../../../src/core/review/validated/finding";
import {
  decodeFindingMarker,
  decodeReviewState,
  decodeSeverityMarker,
  SUMMARY_MARKER,
  type ReviewState,
} from "../../../src/core/review/markers";

function oversizedReview(): ReviewRenderInput {
  const finding = normalizeFinding({
    id: "f-real",
    title: "A verified security defect",
    path: "src/a.ts",
    line: 10,
    severity: "P1",
    security: true,
    securitySeverity: "high",
    body: "🛡️".repeat(30000),
    why: "why ".repeat(20000),
    verification: "verified ".repeat(15000),
    agent_prompt: "untrusted ".repeat(20000),
  });
  finding.threadUrl = "https://github.com/example/repo/pull/42#discussion_r123";
  return {
    state: "findings",
    head: "abcdef0123456789abcdef0123456789abcdef0123",
    findings: [finding],
    candidatesConsidered: 3,
    postedCount: 1,
    dropped: [
      { index: 1, path: "b.ts", reason: "existing guard ".repeat(10000) },
      { index: 2, path: "c.ts", reason: "duplicate ".repeat(10000) },
    ],
    showDroppedFindings: true,
    summary: {
      body: "risk ".repeat(30000),
      whatChanged: "changes ".repeat(30000),
      filesReviewed: 3,
    },
    reviewState: {
      head: "abcdef0123456789abcdef0123456789abcdef0123",
      paused: true,
      autoRunCount: 7,
      findings: [
        {
          id: finding.id,
          sev: finding.severity,
          state: "open",
          threadId: "PRRT_real",
          thread: 123,
          url: finding.threadUrl,
          finding,
        },
      ],
    },
  };
}
describe("automatic renderer output budgets", () => {
  it("compacts hidden state without visible footers or lost essential metadata", () => {
    const input = oversizedReview();
    const state: ReviewState = {
      ...input.reviewState!,
      base: "1234567",
      reviewed: ["7654321"],
      depth: "deep",
      diffHash: "trusted-diff",
    };
    state.findings[0]!.commentId = 123;
    state.findings[0]!.path = "src/a.ts";
    state.findings[0]!.line = 10;
    state.findings[0]!.body = "Large legacy snapshot. ".repeat(10000);
    const body = renderReviewStateNote(state);
    expect(outputBytes(body)).toBeLessThanOrEqual(MAX_REVIEW_OUTPUT_BYTES);
    expect(body.replace(/<!--[\s\S]*?-->/g, "").trim()).toBe("");
    expect(body).not.toContain("Some optional review context");
    const decoded = decodeReviewState(body)!;
    expect(decoded).toMatchObject({
      head: state.head,
      base: state.base,
      reviewed: state.reviewed,
      depth: state.depth,
      diffHash: state.diffHash,
      paused: true,
      autoRunCount: 7,
    });
    expect(decoded.findings[0]).toMatchObject({
      id: "f-real",
      sev: "P1",
      state: "open",
      threadId: "PRRT_real",
      thread: 123,
      commentId: 123,
      path: "src/a.ts",
      line: 10,
      url: state.findings[0]!.url,
      finding: { securitySeverity: "high" },
    });
    expect(renderReviewStateNote()).toBe(SUMMARY_MARKER);
    expect(state.findings[0]!.body!.length).toBeGreaterThan(100000);
  });
  it("refuses to truncate essential identities in hidden state notes", () => {
    const state = oversizedReview().reviewState!;
    state.findings[0]!.finding!.id = "essential-id".repeat(10000);
    expect(() => renderReviewStateNote(state)).toThrow(ReviewOutputBudgetError);
  });
  it("bounds large visible/hidden summaries without losing finding identity or lifecycle state", () => {
    const input = oversizedReview();
    for (const render of [
      renderReviewSummary,
      renderStepSummary,
      renderSecurityReport,
      renderReviewBody,
    ]) {
      const body = render(input);
      expect(outputBytes(body)).toBeLessThanOrEqual(MAX_REVIEW_OUTPUT_BYTES);
      expect(validateRenderedMarkdown(body)).toEqual([]);
    }
    const summary = renderReviewSummary(input);
    const state = decodeReviewState(summary);
    expect(state?.findings.map((f) => f.id)).toEqual(["f-real"]);
    expect(state?.findings[0]?.threadId).toBe("PRRT_real");
    expect(state?.findings[0]?.thread).toBe(123);
    expect(state?.findings[0]?.finding?.securitySeverity).toBe("high");
    expect(state?.paused).toBe(true);
    expect(state?.autoRunCount).toBe(7);
    expect(summary).toContain("#discussion_r123");
    expect(summary).toContain("3 considered → 1 posted · 2 dropped");
    expect(summary).toContain("Some optional review context was shortened");
  });
  it("never publishes a truncated suggestion, including multibyte/code-fence content", () => {
    const input = oversizedReview();
    const finding = input.findings![0]!;
    const replacement = `    // COMPLETE_REPLACEMENT_START\n${"x".repeat(100000)}\n`;
    const body = renderInlineComment({ ...finding, suggestion: replacement });
    expect(outputBytes(body)).toBeLessThanOrEqual(MAX_INLINE_OUTPUT_BYTES);
    expect(body).not.toContain("~~~suggestion");
    expect(body).not.toContain("COMPLETE_REPLACEMENT_START");
    expect(body).toContain("No partial suggestion was posted");
    expect(decodeFindingMarker(body)?.id).toBe("f-real");
    expect(validateRenderedMarkdown(body)).toEqual([]);
  });
  it("bounds check output and preserves its machine counts", () => {
    const output = renderCheckRun({
      ...oversizedReview(),
      steps: [{ name: "stage ".repeat(30000), status: "completed" }],
    });
    expect(output.title.length).toBeLessThanOrEqual(255);
    expect(outputBytes(output.summary)).toBeLessThanOrEqual(
      MAX_REVIEW_OUTPUT_BYTES,
    );
    expect(outputBytes(output.text)).toBeLessThanOrEqual(
      MAX_REVIEW_OUTPUT_BYTES,
    );
    expect(decodeSeverityMarker(output.text)).toEqual({
      p0: 0,
      p1: 1,
      p2: 0,
      security: 1,
    });
  });
  it("fails safely if essential identities cannot fit instead of dropping them", () => {
    const input = oversizedReview();
    input.reviewState!.findings[0]!.finding!.id = "essential-id".repeat(10000);
    expect(() => renderReviewSummary(input)).toThrow(ReviewOutputBudgetError);
    expect(() => renderReviewSummary(input)).toThrow(
      "no truncated state was published",
    );
  });
});
