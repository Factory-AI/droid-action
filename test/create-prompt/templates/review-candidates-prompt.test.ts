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

  it("includes understanding phase with ticket fetching instructions", () => {
    const context = createBaseContext({
      reviewArtifacts: {
        diffPath: "/tmp/test/pr.diff",
        commentsPath: "/tmp/test/existing_comments.json",
        descriptionPath: "/tmp/test/pr_description.txt",
      },
    });

    const prompt = generateReviewCandidatesPrompt(context);

    expect(prompt).toContain("<understanding_phase>");
    expect(prompt).toContain("Understand the PR intent");
    expect(prompt).toContain("Read the PR description from");
    expect(prompt).toContain("/tmp/test/pr_description.txt");
  });

  it("instructs to fetch ticket URLs from PR description", () => {
    const context = createBaseContext();

    const prompt = generateReviewCandidatesPrompt(context);

    expect(prompt).toContain("ticket URL");
    expect(prompt).toContain("ticket ID");
    expect(prompt).toContain("always fetch it");
    expect(prompt).toContain("FetchUrl");
  });

  it("places understanding phase before review guidelines", () => {
    const context = createBaseContext();

    const prompt = generateReviewCandidatesPrompt(context);

    const understandingIdx = prompt.indexOf("<understanding_phase>");
    const guidelinesIdx = prompt.indexOf("<review_guidelines>");
    expect(understandingIdx).toBeGreaterThan(-1);
    expect(guidelinesIdx).toBeGreaterThan(-1);
    expect(understandingIdx).toBeLessThan(guidelinesIdx);
  });

  it("includes triage and parallel review phases", () => {
    const context = createBaseContext();

    const prompt = generateReviewCandidatesPrompt(context);

    expect(prompt).toContain("<triage_phase>");
    expect(prompt).toContain("<parallel_review_phase>");
    expect(prompt).toContain("<aggregation_phase>");
    expect(prompt).toContain("file-group-reviewer");
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

  it("includes review guidelines when provided", () => {
    const context = createBaseContext({
      reviewGuidelines: "- Focus on performance\n- Check for memory leaks",
    });

    const prompt = generateReviewCandidatesPrompt(context);

    expect(prompt).toContain("<custom_review_guidelines>");
    expect(prompt).toContain("- Focus on performance");
    expect(prompt).toContain("- Check for memory leaks");
  });

  it("does not include review guidelines section when not provided", () => {
    const context = createBaseContext();

    const prompt = generateReviewCandidatesPrompt(context);

    expect(prompt).not.toContain("<custom_review_guidelines>");
  });

  it("places review guidelines before context section", () => {
    const context = createBaseContext({
      reviewGuidelines: "Custom guideline",
    });

    const prompt = generateReviewCandidatesPrompt(context);

    const guidelinesIdx = prompt.indexOf("<custom_review_guidelines>");
    const contextIdx = prompt.indexOf("<context>");
    expect(guidelinesIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeGreaterThan(-1);
    expect(guidelinesIdx).toBeLessThan(contextIdx);
  });
});
