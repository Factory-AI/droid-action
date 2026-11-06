import { describe, expect, it } from "bun:test";
import { z } from "zod";
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
import { generateReviewCandidatesPrompt } from "../../../../src/create-prompt/templates/review-candidates-prompt";
import { generateReviewValidatorPrompt } from "../../../../src/create-prompt/templates/review-validator-prompt";
import type { PreparedContext } from "../../../../src/create-prompt/types";
import { promptOutput } from "../../../helpers/legacy-review-contract";

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
const github: PreparedContext = {
  repository: "owner/repo",
  triggerPhrase: "@droid",
  eventData: {
    eventName: "pull_request",
    isPR: true,
    prNumber: "4",
    baseBranch: "main",
  },
  prBranchData: { headRefName: "feat", headRefOid: "abc" },
  reviewArtifacts: paths,
  reviewGuidelines: repoGuidelines,
};

describe("platform prompt adapters carry repository review guidelines", () => {
  it.each([
    [
      "GitHub",
      () => generateReviewCandidatesPrompt(github),
      () => generateReviewValidatorPrompt(github),
    ],
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
    for (const [pass, generate] of [
      ["comments", candidates],
      ["results", validator],
    ] as const) {
      const prompt = generate();
      const output = promptOutput(prompt, pass);
      expect(output.version).toBe(1);
      const entries = z.array(z.record(z.unknown())).parse(output[pass]);
      expect(entries).toHaveLength(pass === "comments" ? 1 : 2);
      if (pass === "results")
        expect(entries.map((entry) => entry.status)).toEqual([
          "approved",
          "rejected",
        ]);
      const summary = z
        .object({ body: z.string() })
        .parse(output.reviewSummary);
      expect(summary.body).toContain(
        "\n\n- optional whole-change observation (at most three bullets)",
      );
      expect(prompt.replace(/\s+/g, " ")).toContain(
        pass === "comments" ? "up to three short bullets" : "through unchanged",
      );
      if (
        pass === "results" &&
        (_platform === "GitHub" || _platform === "GitLab")
      ) {
        expect(output.reviewSummary).toHaveProperty("whatChanged");
        expect(output.reviewSummary).toHaveProperty("changes");
        expect(output.reviewSummary).toHaveProperty("risk");
      } else {
        const keys = Object.keys(
          z.record(z.unknown()).parse(output.reviewSummary),
        );
        expect(keys).toEqual(
          pass === "comments" ? ["body"] : ["status", "body"],
        );
      }
    }
  });
});
