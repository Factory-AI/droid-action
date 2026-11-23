import { describe, expect, it, mock } from "bun:test";
import { postGitHubReview } from "../../src/entrypoints/github-post-review";
import { parseValidatedReview } from "../../src/core/review/validated/parse";

const replacement = "  fixedA();\n  fixedB();\n\n  fixedD();";
const agentPrompt =
  "Keep the full 8..11 range.\nPreserve indentation and blank lines.";
const patch = (hunks: string) =>
  `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n${hunks}\n`;
const fullRange = patch("@@ -8,4 +8,4 @@\n a\n b\n c\n d");

async function publish(diff: string, side: "LEFT" | "RIGHT" = "RIGHT") {
  const parsed = parseValidatedReview(
    JSON.stringify({
      results: [
        {
          status: "approved",
          comment: {
            path: "src/x.ts",
            body: "Replace the complete range.",
            title: "Correct range",
            severity: "P1",
            line: 11,
            startLine: 8,
            side,
            suggestion: replacement,
            agent_prompt: agentPrompt,
          },
        },
      ],
    }),
  );
  const createReview = mock(async (_payload: any) => ({ data: { id: 42 } }));
  const result = await postGitHubReview({
    client: { rest: { pulls: { createReview } } },
    owner: "o",
    repo: "r",
    prNumber: 7,
    comments: parsed.approved,
    findings: parsed.findings,
    diff,
  });
  return { result, createReview };
}

describe("rendered suggestions preserve their complete publication range", () => {
  it("posts the exact valid 8..11 range and unchanged replacement and agent text", async () => {
    const { createReview, result } = await publish(fullRange);
    expect(result.posted).toBe(1);
    const payload = createReview.mock.calls[0]![0];
    expect(payload.comments[0]).toMatchObject({
      line: 11,
      side: "RIGHT",
      start_line: 8,
      start_side: "RIGHT",
    });
    expect(payload.comments[0].body).toContain(`suggestion\n${replacement}\n`);
    expect(payload.comments[0].body).toContain(agentPrompt);
  });

  it.each([
    ["missing start", patch("@@ -11 +11 @@\n d")],
    ["missing interior hunk", patch("@@ -8 +8 @@\n a\n@@ -11 +11 @@\n d")],
    ["missing end", patch("@@ -8,3 +8,3 @@\n a\n b\n c")],
  ])(
    "preserves an invalid %s range only as a non-inline finding",
    async (_name, diff) => {
      const { createReview, result } = await publish(diff);
      expect(createReview).not.toHaveBeenCalled();
      expect(result.posted).toBe(0);
      expect(result.fallbackPosted).toBe(1);
      expect(result.findings?.[0]).toMatchObject({
        outside_diff: true,
        startLine: 8,
        line: 11,
        suggestion: replacement,
        agent_prompt: agentPrompt,
      });
    },
  );

  it("keeps a LEFT range without an applyable suggestion", async () => {
    const { createReview } = await publish(fullRange, "LEFT");
    const payload = createReview.mock.calls[0]![0];
    expect(payload.comments[0]).toMatchObject({
      line: 11,
      side: "LEFT",
      start_line: 8,
      start_side: "LEFT",
    });
    expect(payload.comments[0].body).not.toMatch(/(?:`{3,}|~{3,})suggestion/);
    expect(payload.comments[0].body).toContain(agentPrompt);
  });

  it("also rejects an incomplete LEFT range without narrowing it", async () => {
    const { createReview, result } = await publish(
      patch("@@ -11 +11 @@\n d"),
      "LEFT",
    );
    expect(createReview).not.toHaveBeenCalled();
    expect(result.fallbackPosted).toBe(1);
  });

  it("retains legacy single-line suggestion behavior", async () => {
    const parsed = parseValidatedReview(
      JSON.stringify({
        results: [
          {
            status: "approved",
            comment: {
              path: "src/x.ts",
              line: 11,
              body: "[P1] Legacy\n\n```suggestion\nfixed();\n```",
            },
          },
        ],
      }),
    );
    const createReview = mock(async (_payload: any) => ({ data: { id: 43 } }));
    await postGitHubReview({
      client: { rest: { pulls: { createReview } } },
      owner: "o",
      repo: "r",
      prNumber: 7,
      comments: parsed.approved,
      diff: fullRange,
    });
    const payload = createReview.mock.calls[0]![0];
    expect(payload.comments[0]).not.toHaveProperty("start_line");
    expect(payload.comments[0].body).toContain("```suggestion\nfixed();\n```");
  });
});
