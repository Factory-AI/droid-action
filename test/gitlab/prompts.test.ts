import { describe, it, expect } from "bun:test";
import { generateGitlabReviewCandidatesPrompt } from "../../src/gitlab/prompts/candidates";
import { generateGitlabReviewValidatorPrompt } from "../../src/gitlab/prompts/validator";
import type { GitlabReviewPromptContext } from "../../src/gitlab/prompts/types";

function baseCtx(
  overrides: Partial<GitlabReviewPromptContext> = {},
): GitlabReviewPromptContext {
  return {
    projectPath: "top-group/sub/project",
    mrIid: 42,
    mrTitle: "Add feature X",
    sourceBranch: "feat/x",
    targetBranch: "main",
    headSha: "deadbeef1234567890abcdef",
    diffPath: "/tmp/droid-prompts/mr.diff",
    commentsPath: "/tmp/droid-prompts/existing_comments.json",
    descriptionPath: "/tmp/droid-prompts/mr_description.txt",
    candidatesPath: "/tmp/droid-prompts/review_candidates.json",
    validatedPath: "/tmp/droid-prompts/review_validated.json",
    includeSuggestions: true,
    securityReviewEnabled: false,
    ...overrides,
  };
}

describe("generateGitlabReviewCandidatesPrompt", () => {
  it("uses MR/project terminology, not PR/repo", () => {
    const prompt = generateGitlabReviewCandidatesPrompt(baseCtx());
    expect(prompt).toContain("MR !42");
    expect(prompt).toContain("top-group/sub/project");
    expect(prompt).toContain("MR IID: 42");
    expect(prompt).toContain("MR Source Branch: feat/x");
    expect(prompt).toContain("MR Target Branch: main");
    expect(prompt).toContain("MR Head SHA: deadbeef1234567890abcdef");
    expect(prompt).not.toMatch(/\bPR #\d+\b/);
    expect(prompt).not.toContain("PR Head Ref");
  });

  it("references the three artifact files and candidates output", () => {
    const prompt = generateGitlabReviewCandidatesPrompt(baseCtx());
    expect(prompt).toContain("/tmp/droid-prompts/mr.diff");
    expect(prompt).toContain("/tmp/droid-prompts/existing_comments.json");
    expect(prompt).toContain("/tmp/droid-prompts/mr_description.txt");
    expect(prompt).toContain("/tmp/droid-prompts/review_candidates.json");
  });

  it("instructs the model to invoke the review skill Pass 1 procedure", () => {
    const prompt = generateGitlabReviewCandidatesPrompt(baseCtx());
    expect(prompt).toContain("Invoke the 'review' skill");
    expect(prompt).toContain("Pass 1: Candidate Generation");
  });

  it("explicitly forbids writing to GitLab by any route", () => {
    const prompt = generateGitlabReviewCandidatesPrompt(baseCtx());
    expect(prompt).toContain("post to GitLab");
    expect(prompt).toMatch(/DO NOT\*?\*?\s+post to GitLab/);
    expect(prompt).toContain("GitLab REST API");
    expect(prompt).toContain("glab");
  });

  it("includes the security-reviewer subagent block only when enabled", () => {
    const off = generateGitlabReviewCandidatesPrompt(
      baseCtx({ securityReviewEnabled: false }),
    );
    expect(off).not.toContain("security-reviewer");

    const on = generateGitlabReviewCandidatesPrompt(
      baseCtx({ securityReviewEnabled: true }),
    );
    expect(on).toContain("security-reviewer");
    expect(on).toContain("Task tool");
    expect(on).toContain("[security]");
  });

  it("drops suggestion-block guidance when includeSuggestions is false", () => {
    const off = generateGitlabReviewCandidatesPrompt(
      baseCtx({ includeSuggestions: false }),
    );
    expect(off).toContain("Do NOT include code suggestion blocks");
    expect(off).not.toContain("suggestion block rules");
  });
});

describe("generateGitlabReviewValidatorPrompt", () => {
  it("identifies itself as Phase 2 / validator", () => {
    const prompt = generateGitlabReviewValidatorPrompt(baseCtx());
    expect(prompt).toContain("Phase 2 (validator)");
    expect(prompt).toContain("Pass 2: Validation");
  });

  it("uses GitLab MR terminology, not GitHub PR terminology", () => {
    const prompt = generateGitlabReviewValidatorPrompt(baseCtx());
    expect(prompt).toContain("MR !42");
    expect(prompt).not.toMatch(/\bPR #\d+\b/);
    expect(prompt).not.toContain("github_pr___submit_review");
  });

  it("makes the validated file the deliverable instead of a posting tool", () => {
    const prompt = generateGitlabReviewValidatorPrompt(baseCtx());
    expect(prompt).toContain("Do not post anything yourself");
    expect(prompt).toContain(
      "Writing `/tmp/droid-prompts/review_validated.json` is your final action",
    );
    expect(prompt).toContain("through the GitLab API");
    expect(prompt).not.toContain("submit_review");
    expect(prompt).not.toContain("gitlab_mr___");
    expect(prompt).not.toContain("update_tracking_note");
    // An approved comment with no anchor is silently unpostable.
    expect(prompt).toContain("without a usable line anchor");
  });

  it("enforces the approved/rejected ordering contract", () => {
    const prompt = generateGitlabReviewValidatorPrompt(baseCtx());
    expect(prompt).toContain('status === "approved"');
    expect(prompt).toContain("Preserve ordering");
    expect(prompt).toContain("exactly one entry per candidate");
  });

  it("points at the right artifact paths from state", () => {
    const ctx = baseCtx({
      diffPath: "/custom/mr.diff",
      commentsPath: "/custom/comments.json",
      descriptionPath: "/custom/desc.txt",
      candidatesPath: "/custom/candidates.json",
      validatedPath: "/custom/validated.json",
    });
    const prompt = generateGitlabReviewValidatorPrompt(ctx);
    expect(prompt).toContain("/custom/mr.diff");
    expect(prompt).toContain("/custom/comments.json");
    expect(prompt).toContain("/custom/desc.txt");
    expect(prompt).toContain("/custom/candidates.json");
    expect(prompt).toContain("/custom/validated.json");
  });
});
