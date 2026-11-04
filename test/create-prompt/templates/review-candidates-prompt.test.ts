import { describe, expect, it } from "bun:test";
import { generateReviewCandidatesPrompt } from "../../../src/create-prompt/templates/review-candidates-prompt";
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
    prBranchData: {
      headRefName: "feature/test",
      headRefOid: "abc123def",
    },
    githubContext: undefined,
    ...overrides,
  } as PreparedContext;
}

describe("generateReviewCandidatesPrompt", () => {
  it("references PR description artifact in precomputed data files", () => {
    const context = createBaseContext({
      reviewArtifacts: {
        diffPath: "/tmp/test/pr.diff",
        commentsPath: "/tmp/test/existing_comments.json",
        descriptionPath: "/tmp/test/pr_description.txt",
      },
    });

    const prompt = generateReviewCandidatesPrompt(context);

    expect(prompt).toContain("PR Description: `/tmp/test/pr_description.txt`");
    expect(prompt).toContain("Full PR Diff: `/tmp/test/pr.diff`");
    expect(prompt).toContain(
      "Existing Comments: `/tmp/test/existing_comments.json`",
    );
  });

  it("uses fallback description path when artifacts are not provided", () => {
    const context = createBaseContext();

    const prompt = generateReviewCandidatesPrompt(context);

    expect(prompt).toContain("pr_description.txt");
  });

  it("instructs to invoke the review skill for Pass 1", () => {
    const context = createBaseContext();

    const prompt = generateReviewCandidatesPrompt(context);

    expect(prompt).toContain("Invoke the 'review' skill");
    expect(prompt).toContain("Pass 1: Candidate Generation");
  });

  it("includes senior engineer framing", () => {
    const context = createBaseContext();

    const prompt = generateReviewCandidatesPrompt(context);

    expect(prompt).toContain(
      "You are a senior staff software engineer and expert code reviewer",
    );
  });

  it("includes output spec with correct schema", () => {
    const context = createBaseContext();

    const prompt = generateReviewCandidatesPrompt(context);

    expect(prompt).toContain("<output_spec>");
    expect(prompt).toContain("review_candidates");
    expect(prompt).toContain('"version": 1');
    expect(prompt).toContain("reviewSummary");
  });

  it("includes critical constraints to not post to GitHub", () => {
    const context = createBaseContext();

    const prompt = generateReviewCandidatesPrompt(context);

    expect(prompt).toContain("<critical_constraints>");
    expect(prompt).toContain("DO NOT** post to GitHub");
  });

  it("includes PR context with correct values", () => {
    const context = createBaseContext({
      prBranchData: {
        headRefName: "feat/my-branch",
        headRefOid: "sha123abc",
      },
      eventData: {
        eventName: "issue_comment",
        commentId: "456",
        prNumber: "99",
        isPR: true,
        commentBody: "@droid review",
        baseBranch: "develop",
      },
    });

    const prompt = generateReviewCandidatesPrompt(context);

    expect(prompt).toContain("PR Number: 99");
    expect(prompt).toContain("PR Head Ref: feat/my-branch");
    expect(prompt).toContain("PR Head SHA: sha123abc");
    expect(prompt).toContain("PR Base Ref: develop");
  });

  it("includes suggestion block rules reference when suggestions enabled", () => {
    const context = createBaseContext({ includeSuggestions: true });

    const prompt = generateReviewCandidatesPrompt(context);

    expect(prompt).toContain("suggestion block rules");
  });

  it("excludes suggestion blocks when suggestions disabled", () => {
    const context = createBaseContext({ includeSuggestions: false });

    const prompt = generateReviewCandidatesPrompt(context);

    expect(prompt).toContain("Do NOT include code suggestion blocks");
    expect(prompt).not.toContain("suggestion block rules");
  });

  it("carries the repository's review guidelines verbatim ahead of the context", () => {
    const context = createBaseContext({
      reviewGuidelines: {
        source: ".factory/skills/review-guidelines/SKILL.md@main",
        body: "# Team rules\n\n- Flag any new `Date.now()` call.",
        path: "/tmp/test/review_guidelines.md",
      },
    });

    const prompt = generateReviewCandidatesPrompt(context);

    const block =
      '<review-guidelines source=".factory/skills/review-guidelines/SKILL.md@main">\n# Team rules\n\n- Flag any new `Date.now()` call.\n</review-guidelines>';
    expect(prompt).toContain(block);
    expect(prompt.indexOf(block)).toBeLessThan(prompt.indexOf("<context>"));
    expect(prompt).toContain(
      "copy the `<review-guidelines>` block below verbatim into each subagent's prompt",
    );
  });

  it("says nothing about guidelines when the repository has none", () => {
    const prompt = generateReviewCandidatesPrompt(createBaseContext());

    expect(prompt).not.toContain("review-guidelines");
    expect(prompt).not.toContain("Repository review guidelines");
  });
});
