import { describe, expect, it } from "bun:test";
import { generateSecurityCandidatesPrompt } from "../../../src/create-prompt/templates/security-review-prompt";
import type { PreparedContext } from "../../../src/create-prompt/types";

function createBaseContext(
  overrides: Partial<PreparedContext> = {},
): PreparedContext {
  return {
    repository: "test-owner/test-repo",
    droidCommentId: "123",
    triggerPhrase: "@droid",
    eventData: {
      eventName: "issue_comment",
      commentId: "456",
      prNumber: "42",
      isPR: true,
      commentBody: "@droid security-review",
    },
    githubContext: undefined,
    ...overrides,
  } as PreparedContext;
}

describe("generateSecurityCandidatesPrompt", () => {
  it("includes security context and skill invocation", () => {
    const prompt = generateSecurityCandidatesPrompt(createBaseContext());

    expect(prompt).toContain("security-focused code review");
    expect(prompt).toContain("security-review");
    expect(prompt).toContain("Invoke the 'security-review' skill");
    expect(prompt).toContain("Pass 1: Candidate Generation");
    expect(prompt).toContain("DO NOT");
  });

  it("includes PR context with correct values", () => {
    const prompt = generateSecurityCandidatesPrompt(createBaseContext());

    expect(prompt).toContain("PR Number: 42");
    expect(prompt).toContain("test-owner/test-repo");
  });

  it("includes output spec with correct schema", () => {
    const prompt = generateSecurityCandidatesPrompt(createBaseContext());

    expect(prompt).toContain("version");
    expect(prompt).toContain("meta");
    expect(prompt).toContain("comments");
    expect(prompt).toContain("reviewSummary");
    expect(prompt).toContain("commit_id");
    expect(prompt).toContain("STRIDE");
  });

  it("includes critical constraints to not post to GitHub", () => {
    const prompt = generateSecurityCandidatesPrompt(createBaseContext());

    expect(prompt).toContain("DO NOT** post to GitHub");
    expect(prompt).toContain("DO NOT** invoke any PR mutation tools");
  });

  it("uses precomputed data files when review artifacts provided", () => {
    const context = createBaseContext({
      reviewArtifacts: {
        diffPath: "/tmp/droid-prompts/pr.diff",
        commentsPath: "/tmp/droid-prompts/existing_comments.json",
        descriptionPath: "/tmp/droid-prompts/pr_description.txt",
      },
    });

    const prompt = generateSecurityCandidatesPrompt(context);

    expect(prompt).toContain("/tmp/droid-prompts/pr.diff");
    expect(prompt).toContain("/tmp/droid-prompts/existing_comments.json");
    expect(prompt).toContain("/tmp/droid-prompts/pr_description.txt");
  });
});
