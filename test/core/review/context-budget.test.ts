import { describe, expect, it } from "bun:test";
import {
  MAX_REVIEW_OUTPUT_BYTES,
  outputBytes,
  renderReviewSummary,
  validateRenderedMarkdown,
  type ReviewRenderInput,
} from "../../../src/core/review/render";
import { normalizeFinding } from "../../../src/core/review/validated/finding";
import { decodeReviewState } from "../../../src/core/review/markers";

const head = "a".repeat(40);
function review(platform: "github" | "gitlab"): ReviewRenderInput {
  const findings = Array.from({ length: 30 }, (_, i) =>
    normalizeFinding({
      id: `f-context-${i}`,
      title: `Preserve request guard ${i}`,
      severity: "P1",
      path: `src/${"p".repeat(66)}/file-${i}.ts`,
      line: 11,
      body: "The request guard must remain effective.",
      why: "Requests otherwise bypass validation.",
      verification: "Traced the request path.",
      agent_prompt: "Verify the guard against the current source.",
      also_at: Array.from({ length: 5 }, (_, j) => ({
        path: `src/${"r".repeat(64)}/more-${i}-${j}.ts`,
        line: 12 + j,
      })),
    }),
  );
  return {
    state: "findings",
    platform,
    repositoryUrl:
      platform === "github"
        ? "https://github.com/Factory-AI/droid-action"
        : "https://gitlab.com/example/droid-action",
    head,
    findings,
    candidatesConsidered: 30,
    postedCount: 30,
    reviewState: {
      head,
      findings: findings.map((finding) => ({
        id: finding.id,
        sev: finding.severity,
        state: "open",
        finding,
        path: finding.path,
        line: finding.line ?? undefined,
      })),
    },
  };
}

describe("optional finding context under real renderer budgets", () => {
  it.each(["github", "gitlab"] as const)(
    "compacts 30 findings with five related 80-character paths on %s",
    (platform) => {
      const input = review(platform);
      const before = JSON.stringify(input);
      const withoutOptional = renderReviewSummary({
        ...input,
        findings: input.findings!.map((finding) => ({
          ...finding,
          also_at: [],
          why: "",
          verification: "",
        })),
      });
      expect(outputBytes(withoutOptional)).toBeLessThanOrEqual(
        MAX_REVIEW_OUTPUT_BYTES,
      );
      const body = renderReviewSummary(input);
      expect(outputBytes(body)).toBeLessThanOrEqual(MAX_REVIEW_OUTPUT_BYTES);
      expect(validateRenderedMarkdown(body)).toEqual([]);
      expect(
        decodeReviewState(body)?.findings.map((finding) => finding.id),
      ).toEqual(input.findings!.map((finding) => finding.id));
      expect(body).toContain("30 considered → 30 posted");
      expect(JSON.stringify(input)).toBe(before);
    },
  );
});
