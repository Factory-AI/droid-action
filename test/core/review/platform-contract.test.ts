import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  generateBitbucketCandidatesPrompt,
  generateBitbucketValidatorPrompt,
  BITBUCKET_TERMINOLOGY,
} from "../../../src/bitbucket/prompts";
import {
  generateAzureDevopsCandidatesPrompt,
  generateAzureDevopsValidatorPrompt,
  AZURE_DEVOPS_TERMINOLOGY,
} from "../../../src/azure-devops/prompts";
import { generateReviewCandidatesPrompt } from "../../../src/create-prompt/templates/review-candidates-prompt";
import { generateReviewValidatorPrompt } from "../../../src/create-prompt/templates/review-validator-prompt";
import { generateGitlabReviewCandidatesPrompt } from "../../../src/gitlab/prompts/candidates";
import { generateGitlabReviewValidatorPrompt } from "../../../src/gitlab/prompts/validator";
import { generateCandidatesPrompt as legacyCandidates } from "../../../src/core/review/prompts/legacy-candidates";
import { generateValidatorPrompt as legacyValidator } from "../../../src/core/review/prompts/legacy-validator";
import { reviewPromptSettingsFromEnvironment } from "../../../src/core/review/prompts/settings";
import type { ReviewPromptContext } from "../../../src/core/review/prompts/types";
import { GITHUB_TERMINOLOGY } from "../../../src/create-prompt/terminology";
import type { PreparedContext } from "../../../src/create-prompt/types";
import { parseValidatedReview } from "../../../src/core/review/validated/parse";
import { renderReviewSummary } from "../../../src/core/review/render";
import {
  legacyCandidatesFromPrompt,
  legacyValidatedFromPrompt,
  promptOutput,
} from "../../helpers/legacy-review-contract";

const HEAD = "abcdef0123456789abcdef0123456789abcdef0123";
const paths = {
  diffPath: "/tmp/review.diff",
  commentsPath: "/tmp/comments.json",
  descriptionPath: "/tmp/description.txt",
  candidatesPath: "/tmp/candidates.json",
  validatedPath: "/tmp/validated.json",
};

function common(includeSuggestions = true) {
  return {
    ...paths,
    sourceBranch: "feature",
    targetBranch: "main",
    headSha: HEAD,
    includeSuggestions,
    securityReviewEnabled: true,
  };
}

function github(
  includeSuggestions = true,
  repo = "example/repo",
): PreparedContext {
  return {
    repository: repo,
    triggerPhrase: "@droid",
    eventData: {
      eventName: "pull_request",
      isPR: true,
      prNumber: "42",
      baseBranch: "main",
    },
    prBranchData: { headRefName: "feature", headRefOid: HEAD },
    reviewArtifacts: paths,
    includeSuggestions,
  };
}

const legacyPlatforms = [
  {
    name: "Bitbucket",
    candidates: (includeSuggestions: boolean) =>
      generateBitbucketCandidatesPrompt({
        ...common(includeSuggestions),
        repoFullName: "example/repo",
        prId: 42,
      }),
    validator: (includeSuggestions: boolean) =>
      generateBitbucketValidatorPrompt({
        ...common(includeSuggestions),
        repoFullName: "example/repo",
        prId: 42,
      }),
  },
  {
    name: "Azure DevOps",
    candidates: (includeSuggestions: boolean) =>
      generateAzureDevopsCandidatesPrompt({
        ...common(includeSuggestions),
        repository: "example/repo",
        pullRequestId: 42,
      }),
    validator: (includeSuggestions: boolean) =>
      generateAzureDevopsValidatorPrompt({
        ...common(includeSuggestions),
        repository: "example/repo",
        pullRequestId: 42,
      }),
  },
];

const richPlatforms = [
  {
    name: "GitHub",
    platform: "github",
    candidates: (suggestions: boolean, repo?: string) =>
      generateReviewCandidatesPrompt(github(suggestions, repo)),
    validator: (suggestions: boolean, repo?: string) =>
      generateReviewValidatorPrompt(github(suggestions, repo)),
  },
  {
    name: "GitLab",
    platform: "gitlab",
    candidates: (suggestions: boolean, repo = "example/repo") =>
      generateGitlabReviewCandidatesPrompt({
        ...common(suggestions),
        projectPath: repo,
        mrIid: 42,
        mrTitle: "Change the request path",
      }),
    validator: (suggestions: boolean, repo = "example/repo") =>
      generateGitlabReviewValidatorPrompt({
        ...common(suggestions),
        projectPath: repo,
        mrIid: 42,
        mrTitle: "Change the request path",
      }),
  },
] satisfies Array<{
  name: string;
  platform: "github" | "gitlab";
  candidates: (suggestions: boolean, repo?: string) => string;
  validator: (suggestions: boolean, repo?: string) => string;
}>;

describe("platform-specific review output contracts", () => {
  for (const platform of legacyPlatforms) {
    it(`${platform.name} renders the legacy protocol in both passes`, () => {
      for (const suggestions of [true, false]) {
        const candidates = platform.candidates(suggestions);
        legacyCandidatesFromPrompt(candidates);
        legacyValidatedFromPrompt(platform.validator(suggestions), {
          path: "src/app.ts",
          inlineLine: 3,
          headSha: HEAD,
        });
        if (suggestions) expect(candidates).toContain("suggestion block rules");
        else {
          expect(candidates).toContain("Do NOT include code suggestion blocks");
          expect(platform.validator(false)).toContain(
            "Do NOT include code suggestion blocks",
          );
        }
      }
    });

    it(`${platform.name} independently renders the legacy validator protocol`, () => {
      legacyValidatedFromPrompt(platform.validator(true), {
        path: "src/app.ts",
        inlineLine: 3,
        headSha: HEAD,
      });
    });
  }

  for (const platform of richPlatforms) {
    it(`${platform.name} retains rich outside findings and summary rendering`, () => {
      const candidates = platform.candidates(true);
      const validator = platform.validator(true);
      expect(candidates).toContain("outside_diff: true");
      expect(validator).toContain("set `outside_diff: true`");
      expect(validator).toContain("eligibleFixedIds");
      expect(validator).toContain("exactly one entry per candidate");
      expect(validator).toContain("separate top-level `findingResolutions`");
      expect(validator).toContain("absent candidates do NOT prove a fix");
      expect(validator).toContain("human-resolved/dismissed");
      const output = promptOutput(validator, "results");
      const entries = z.array(z.unknown()).parse(output.results);
      const entry = z
        .object({ status: z.string(), comment: z.record(z.unknown()) })
        .parse(entries[0]);
      const summary = z
        .object({ whatChanged: z.string() })
        .parse(output.reviewSummary);
      const parsed = parseValidatedReview(
        JSON.stringify({
          ...output,
          results: [
            {
              ...entry,
              comment: {
                ...entry.comment,
                severity: "P0",
                title: "An untouched defect remains visible",
                body: "The changed caller exposes the existing unsafe path.",
                outside_diff: true,
                line: 40,
              },
            },
          ],
          findingResolutions: [
            { id: "verified", status: "fixed", evidence: "Checked the guard." },
            { id: "unverified", status: "fixed", evidence: "" },
          ],
        }),
      );
      expect(parsed.approvedCount).toBe(1);
      expect(parsed.approved).toHaveLength(0);
      expect(parsed.outsideDiff).toHaveLength(1);
      expect(parsed.findings).toHaveLength(1);
      expect(parsed.fixedFindingIds).toEqual(["verified"]);
      const rendered = renderReviewSummary({
        state: "findings",
        platform: platform.platform,
        findings: parsed.findings,
        summary: parsed.summary,
        badges: "text",
      });
      expect(rendered).toContain("An untouched defect remains visible");
      expect(rendered).toContain("P0");
      expect(rendered).toContain(summary.whatChanged);
    });

    it(`${platform.name} still disables suggestions and redacts both prompts`, () => {
      const secret = `fk-${"x".repeat(25)}`;
      const candidates = platform.candidates(false, `example/${secret}`);
      const validator = platform.validator(false, `example/${secret}`);
      expect(candidates).toContain("Do NOT include code suggestion blocks");
      expect(validator).toContain("Omit the `suggestion` field entirely");
      for (const prompt of [candidates, validator]) {
        expect(prompt).not.toContain(secret);
        expect(prompt).toContain("[REDACTED_FACTORY_API_KEY]");
      }
    });
  }
});

describe("unchanged legacy builder mode semantics", () => {
  const context: ReviewPromptContext = {
    terminology: GITHUB_TERMINOLOGY,
    entityNumber: 42,
    repoOrProject: "example/repo",
    headRef: "feature",
    headSha: HEAD,
    baseRef: "main",
    ...paths,
    includeSuggestions: true,
    securityReviewEnabled: false,
  };

  it("keeps candidate mode undefined and ignores optional rich settings", () => {
    legacyCandidatesFromPrompt(legacyCandidates(context));
    expect(
      legacyCandidates({
        ...context,
        reviewSettings: reviewPromptSettingsFromEnvironment({}),
      }),
    ).toBe(legacyCandidates(context));
  });

  it("keeps default and explicit tool mode identical without rich file rules", () => {
    const toolContext = {
      ...context,
      terminology: {
        ...context.terminology,
        submitReviewToolName: "test_submit_review",
        updateTrackingToolName: "test_update_tracking",
      },
    };
    const implicit = legacyValidator(toolContext);
    expect(legacyValidator({ ...toolContext, postingMode: "tool" })).toBe(
      implicit,
    );
    expect(implicit).toContain("### Post approved items");
    expect(implicit).not.toContain("outside_diff");
    expect(implicit).not.toContain("layout-free structured fields");
    expect(implicit).not.toContain("raw replacement code");
  });

  it("refuses default or explicit tool mode for file-only BB and ADO terminology", () => {
    for (const terminology of [
      BITBUCKET_TERMINOLOGY,
      AZURE_DEVOPS_TERMINOLOGY,
    ]) {
      expect(() => legacyValidator({ ...context, terminology })).toThrow(
        'postingMode "tool" requires terminology.submitReviewToolName',
      );
      expect(() =>
        legacyValidator({ ...context, terminology, postingMode: "tool" }),
      ).toThrow('postingMode "tool" requires terminology.submitReviewToolName');
    }
  });

  it("keeps explicit file mode legacy even with rich settings present", () => {
    const file = legacyValidator({
      ...context,
      postingMode: "file",
      reviewSettings: reviewPromptSettingsFromEnvironment({}),
    });
    legacyValidatedFromPrompt(file, {
      path: "src/app.ts",
      inlineLine: 3,
      headSha: HEAD,
    });
    expect(file).toContain("Do not post anything yourself");
    expect(file).not.toContain("### Post approved items");
  });
});
