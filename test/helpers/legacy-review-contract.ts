import { expect } from "bun:test";
import { z } from "zod";

export const LEGACY_INLINE_BODY = [
  "[P0] [security] Reject requests without an authorized actor",
  "",
  "An unauthenticated request reaches the privileged operation because this path omits the actor check.",
  "",
  "```suggestion",
  '  if (!authorized) throw new Error("denied");',
  "```",
].join("\n");

export const LEGACY_FALLBACK_BODY = [
  "[P0] [security] Preserve authorization on the untouched handler",
  "",
  "The changed caller exposes the existing handler to untrusted requests without checking the actor.",
  "",
  "```suggestion",
  '  if (!actor) throw new Error("denied");',
  "```",
].join("\n");

export function promptOutput(prompt: string, arrayKey: string) {
  for (const match of prompt.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    const output = z.record(z.unknown()).parse(JSON.parse(match[1]!));
    if (Array.isArray(output[arrayKey])) return output;
  }
  throw new Error(`Generated prompt has no ${arrayKey} output schema`);
}

export function legacyCandidatesFromPrompt(
  prompt: string,
  location?: { path: string; inlineLine: number; headSha: string },
) {
  const output = promptOutput(prompt, "comments");
  const comments = z.array(z.record(z.unknown())).parse(output.comments);
  expect(comments[0]?.body).toBe("[P1] Title\n\n1 paragraph.");
  expect(comments[0]).not.toHaveProperty("id");
  expect(prompt).not.toContain("outside_diff");
  expect(prompt).not.toContain("agent_prompt");
  expect(prompt).toContain(
    "Comment text starting with priority tag [P0|P1|P2], then title",
  );
  if (!location) return output;
  const example = comments[0];
  if (!example) throw new Error("Generated prompt has no candidate example");
  const comment = {
    ...example,
    path: location.path,
    line: location.inlineLine,
    startLine: null,
    side: "RIGHT",
    commit_id: location.headSha,
    body: LEGACY_INLINE_BODY,
  };
  return {
    ...output,
    meta: {
      ...z.record(z.unknown()).parse(output.meta),
      headSha: location.headSha,
    },
    comments: [comment, { ...comment, line: 40, body: LEGACY_FALLBACK_BODY }],
  };
}

export function legacyValidatedFromPrompt(
  prompt: string,
  location: { path: string; inlineLine: number; headSha: string },
) {
  const output = promptOutput(prompt, "results");
  const entries = z
    .array(
      z.object({
        status: z.string(),
        comment: z.record(z.unknown()).optional(),
      }),
    )
    .parse(output.results);
  const example = entries.find((entry) => entry.status === "approved")?.comment;
  if (!example) throw new Error("Generated prompt has no approved example");
  expect(example.body).toBe("[P1] Title\n\n1 paragraph.");
  expect(example).not.toHaveProperty("title");
  expect(example).not.toHaveProperty("severity");
  expect(example).not.toHaveProperty("outside_diff");
  expect(prompt).toContain("approved entries are posted verbatim");
  expect(prompt).not.toContain("outside_diff");
  expect(prompt).not.toContain("raw replacement code");
  expect(prompt).toContain("every approved comment keeps its `path`");
  const comment = {
    ...example,
    path: location.path,
    line: location.inlineLine,
    startLine: null,
    side: "RIGHT",
    commit_id: location.headSha,
    body: LEGACY_INLINE_BODY,
  };
  return {
    ...output,
    meta: {
      ...z.record(z.unknown()).parse(output.meta),
      headSha: location.headSha,
    },
    results: [
      { status: "approved", comment },
      {
        status: "approved",
        comment: {
          ...comment,
          line: 40,
          body: LEGACY_FALLBACK_BODY,
        },
      },
    ],
    reviewSummary: {
      status: "approved",
      body: "Two approved findings, including an untouched handler.",
    },
  };
}
