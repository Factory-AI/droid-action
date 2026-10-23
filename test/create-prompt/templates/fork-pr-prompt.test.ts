import { describe, expect, it } from "bun:test";
import { generateReviewCandidatesPrompt } from "../../../src/create-prompt/templates/review-candidates-prompt";
import { generateReviewValidatorPrompt } from "../../../src/create-prompt/templates/review-validator-prompt";
import { generateSecurityCandidatesPrompt } from "../../../src/create-prompt/templates/security-review-prompt";
import type {
  PrBranchPromptData,
  PreparedContext,
} from "../../../src/create-prompt/types";

function contextWith(prBranchData: PrBranchPromptData): PreparedContext {
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
      baseBranch: "main",
    },
    prBranchData,
    githubContext: undefined,
  } as PreparedContext;
}

const SAME_REPO = { headRefName: "feature", headRefOid: "abc123" };
const FORK_REF = "refs/remotes/droid/pr-42-head";

const generators = {
  candidates: generateReviewCandidatesPrompt,
  validator: generateReviewValidatorPrompt,
  security: generateSecurityCandidatesPrompt,
};

describe("fork PR prompts", () => {
  for (const [name, generate] of Object.entries(generators)) {
    it(`${name}: says nothing about forks for a same-repository PR`, () => {
      const prompt = generate(contextWith({ ...SAME_REPO, isFork: false }));
      expect(prompt).not.toContain("<pr_source>");
    });

    it(`${name}: tells the model a fork PR is untrusted and not checked out`, () => {
      const prompt = generate(
        contextWith({ ...SAME_REPO, isFork: true, headRevision: FORK_REF }),
      );
      expect(prompt).toContain("<pr_source>");
      expect(prompt).toContain("was not checked out for this review");
      expect(prompt).toContain("the base repository (main)");
      expect(prompt).toContain(`git show ${FORK_REF}:<path>`);
      expect(prompt).toContain(
        "Never check out, build, install, test, or run the PR's code",
      );
    });

    it(`${name}: points only at the diff when the fork head was not fetched`, () => {
      const prompt = generate(
        contextWith({ ...SAME_REPO, isFork: true, headRevision: null }),
      );
      expect(prompt).toContain("the diff file is the only copy");
      expect(prompt).not.toContain("git show");
    });
  }
});
