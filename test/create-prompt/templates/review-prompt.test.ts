import { describe, expect, it } from "bun:test";
import { generateReviewPrompt } from "../../../src/create-prompt/templates/review-prompt";
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
      commentBody: "@droid review",
    },
    githubContext: undefined,
    ...overrides,
  } as PreparedContext;
}

describe("generateReviewPrompt", () => {
  it("includes objectives and procedure steps", () => {
    const context = createBaseContext();

    const prompt = generateReviewPrompt(context);

    expect(prompt).toContain("## Objectives");
    expect(prompt).toContain("Re-check existing review comments");
    expect(prompt).toContain("github_inline_comment___create_inline_comment");
    expect(prompt).toContain(
      "**Do NOT call** `github_pr___resolve_review_thread`",
    );
  });

  it("includes pre-computed artifact references when provided", () => {
    const context = createBaseContext({
      reviewArtifacts: {
        diffPath: "/tmp/test/pr.diff",
        commentsPath: "/tmp/test/existing_comments.json",
        descriptionPath: "/tmp/test/pr_description.txt",
      },
    });

    const prompt = generateReviewPrompt(context);

    expect(prompt).toContain("### Pre-computed Review Artifacts");
    expect(prompt).toContain("/tmp/test/pr.diff");
    expect(prompt).toContain("/tmp/test/existing_comments.json");
    expect(prompt).toContain("COMPLETE diff");
  });

  it("includes critical instruction to review all files", () => {
    const context = createBaseContext();

    const prompt = generateReviewPrompt(context);

    expect(prompt).toContain("## CRITICAL INSTRUCTION");
    expect(prompt).toContain(
      "DO NOT STOP UNTIL YOU HAVE REVIEWED EVERY SINGLE CHANGED FILE",
    );
    expect(prompt).toContain("Review EACH file systematically");
  });

  it("instructs to read from pre-computed files in Phase 1", () => {
    const context = createBaseContext({
      reviewArtifacts: {
        diffPath: "/tmp/droid/pr.diff",
        commentsPath: "/tmp/droid/comments.json",
        descriptionPath: "/tmp/droid/pr_description.txt",
      },
    });

    const prompt = generateReviewPrompt(context);

    expect(prompt).toContain(
      "Read existing comments** from the pre-computed file",
    );
    expect(prompt).toContain("Read /tmp/droid/comments.json");
    expect(prompt).toContain(
      "Read the COMPLETE diff** from the pre-computed file",
    );
    expect(prompt).toContain("Read /tmp/droid/pr.diff");
  });

  it("emphasizes accuracy gates and bug detection guidelines", () => {
    const prompt = generateReviewPrompt(createBaseContext());

    expect(prompt).toContain("## Priority Levels");
    expect(prompt).toContain("[P0]");
    expect(prompt).toContain(
      "Never open a new finding for an issue previously reported by this bot",
    );
  });

  it("describes submission guidance", () => {
    const prompt = generateReviewPrompt(createBaseContext());

    expect(prompt).toContain(
      "Use `github_inline_comment___create_inline_comment`",
    );
    expect(prompt).toContain("Do **not** approve or request changes");
    expect(prompt).toContain("github_pr___submit_review");
    expect(prompt).toContain("### When NOT to submit");
    expect(prompt).toContain("All findings are low-severity (P2/P3)");
  });

  it("references PR description artifact in pre-computed files", () => {
    const context = createBaseContext({
      reviewArtifacts: {
        diffPath: "/tmp/test/pr.diff",
        commentsPath: "/tmp/test/existing_comments.json",
        descriptionPath: "/tmp/test/pr_description.txt",
      },
    });

    const prompt = generateReviewPrompt(context);

    expect(prompt).toContain("/tmp/test/pr_description.txt");
    expect(prompt).toContain("PR Description");
    expect(prompt).toContain(
      "Contains the PR title and description (body) explaining the intent and scope",
    );
  });

  it("instructs reading PR description first in Phase 1", () => {
    const context = createBaseContext({
      reviewArtifacts: {
        diffPath: "/tmp/droid/pr.diff",
        commentsPath: "/tmp/droid/comments.json",
        descriptionPath: "/tmp/droid/pr_description.txt",
      },
    });

    const prompt = generateReviewPrompt(context);

    expect(prompt).toContain(
      "Read the PR description** to understand the intent and scope",
    );
    expect(prompt).toContain("Read /tmp/droid/pr_description.txt");
    // Verify description is read before comments and diff
    const descIdx = prompt.indexOf("Read the PR description");
    const commentsIdx = prompt.indexOf("Read existing comments");
    const diffIdx = prompt.indexOf("Read the COMPLETE diff");
    expect(descIdx).toBeLessThan(commentsIdx);
    expect(commentsIdx).toBeLessThan(diffIdx);
  });

  it("uses fallback description path when artifacts are not provided", () => {
    const context = createBaseContext();

    const prompt = generateReviewPrompt(context);

    expect(prompt).toContain("pr_description.txt");
  });

  it("includes output file instructions when outputFilePath is set", () => {
    const context = createBaseContext({
      outputFilePath: "/tmp/results/code-review-results.json",
    });

    const prompt = generateReviewPrompt(context);

    expect(prompt).toContain("## Output File (REQUIRED)");
    expect(prompt).toContain("/tmp/results/code-review-results.json");
    expect(prompt).toContain('"type": "code-review"');
    expect(prompt).toContain("combine step to aggregate results");
  });

  it("does not include output file section when outputFilePath is not set", () => {
    const context = createBaseContext();

    const prompt = generateReviewPrompt(context);

    expect(prompt).not.toContain("## Output File (REQUIRED)");
  });
});
