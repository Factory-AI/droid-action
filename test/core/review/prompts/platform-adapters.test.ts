import { describe, expect, it } from "bun:test";
import {
  generateAzureDevopsCandidatesPrompt,
  generateAzureDevopsValidatorPrompt,
} from "../../../../src/azure-devops/prompts";
import {
  generateBitbucketCandidatesPrompt,
  generateBitbucketValidatorPrompt,
} from "../../../../src/bitbucket/prompts";
import { generateGitlabReviewCandidatesPrompt } from "../../../../src/gitlab/prompts/candidates";
import { generateGitlabReviewValidatorPrompt } from "../../../../src/gitlab/prompts/validator";

const repoGuidelines = {
  source: ".factory/skills/review-guidelines/SKILL.md@main",
  body: "# Team rules\n\n- Flag swallowed errors.",
  path: "/tmp/droid-prompts/review_guidelines.md",
};

const paths = {
  diffPath: "/tmp/droid-prompts/pr.diff",
  commentsPath: "/tmp/droid-prompts/existing_comments.json",
  descriptionPath: "/tmp/droid-prompts/pr_description.txt",
  candidatesPath: "/tmp/droid-prompts/review_candidates.json",
  validatedPath: "/tmp/droid-prompts/review_validated.json",
  includeSuggestions: true,
  securityReviewEnabled: false,
};

const block = `<review-guidelines source="${repoGuidelines.source}">\n${repoGuidelines.body}\n</review-guidelines>`;

describe("platform prompt adapters carry repository review guidelines", () => {
  it.each([
    [
      "GitLab",
      () =>
        generateGitlabReviewCandidatesPrompt({
          ...paths,
          projectPath: "group/project",
          mrIid: 4,
          mrTitle: "t",
          sourceBranch: "feat",
          targetBranch: "main",
          headSha: "abc",
          repoGuidelines,
        }),
      () =>
        generateGitlabReviewValidatorPrompt({
          ...paths,
          projectPath: "group/project",
          mrIid: 4,
          mrTitle: "t",
          sourceBranch: "feat",
          targetBranch: "main",
          headSha: "abc",
          repoGuidelines,
        }),
    ],
    [
      "Bitbucket",
      () =>
        generateBitbucketCandidatesPrompt({
          ...paths,
          repoFullName: "ws/repo",
          prId: 4,
          sourceBranch: "feat",
          targetBranch: "main",
          headSha: "abc",
          repoGuidelines,
        }),
      () =>
        generateBitbucketValidatorPrompt({
          ...paths,
          repoFullName: "ws/repo",
          prId: 4,
          sourceBranch: "feat",
          targetBranch: "main",
          headSha: "abc",
          repoGuidelines,
        }),
    ],
    [
      "Azure DevOps",
      () =>
        generateAzureDevopsCandidatesPrompt({
          ...paths,
          repository: "project/repo",
          pullRequestId: 4,
          sourceBranch: "feat",
          targetBranch: "main",
          headSha: "abc",
          repoGuidelines,
        }),
      () =>
        generateAzureDevopsValidatorPrompt({
          ...paths,
          repository: "project/repo",
          pullRequestId: 4,
          sourceBranch: "feat",
          targetBranch: "main",
          headSha: "abc",
          repoGuidelines,
        }),
    ],
  ])("%s: both passes inline the block", (_platform, candidates, validator) => {
    expect(candidates()).toContain(block);
    expect(validator()).toContain(block);
  });
});
