import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import {
  resolveReviewUxConfig,
  reviewConfigFromEnvironment,
  type ReviewUxConfig,
} from "../../../src/core/review/config";
import { reviewPromptSettingsFromEnvironment } from "../../../src/core/review/prompts/settings";
import { generateCandidatesPrompt } from "../../../src/core/review/prompts/candidates";
import { generateValidatorPrompt } from "../../../src/core/review/prompts/validator";
import { generateReviewCandidatesPrompt } from "../../../src/create-prompt/templates/review-candidates-prompt";
import { generateReviewValidatorPrompt } from "../../../src/create-prompt/templates/review-validator-prompt";
import { generateSecurityCandidatesPrompt } from "../../../src/create-prompt/templates/security-review-prompt";
import { GITHUB_TERMINOLOGY } from "../../../src/create-prompt/terminology";
import type { PreparedContext } from "../../../src/create-prompt/types";
import { generateGitlabReviewCandidatesPrompt } from "../../../src/gitlab/prompts/candidates";
import { generateGitlabReviewValidatorPrompt } from "../../../src/gitlab/prompts/validator";
import {
  generateBitbucketCandidatesPrompt,
  generateBitbucketValidatorPrompt,
} from "../../../src/bitbucket/prompts";
import {
  generateAzureDevopsCandidatesPrompt,
  generateAzureDevopsValidatorPrompt,
} from "../../../src/azure-devops/prompts";
import { enrichReviewSummary } from "../../../src/core/review/validated/metadata";
import type { ReviewFinding } from "../../../src/core/review/validated/types";
import { renderReviewSummary } from "../../../src/core/review/render";
import { reviewCheckConclusion } from "../../../src/github/operations/review-checks";

const head = "a".repeat(40);
const artifacts = {
  diffPath: "/tmp/task16/pr.diff",
  commentsPath: "/tmp/task16/comments.json",
  descriptionPath: "/tmp/task16/description.txt",
};
const context: PreparedContext = {
  repository: "example/repo",
  triggerPhrase: "@droid",
  eventData: {
    eventName: "pull_request",
    isPR: true,
    prNumber: "42",
    baseBranch: "main",
  },
  prBranchData: {
    headRefName: "feature",
    headRefOid: head,
    isFork: false,
    headRevision: "HEAD",
  },
  reviewArtifacts: artifacts,
  reviewGuidelines: {
    source: ".factory/skills/review-guidelines/SKILL.md@main",
    body: "Preserve evidence and flag broken retry handling.",
    path: "/tmp/task16/guidelines.md",
  },
};

function withConfig(config: ReviewUxConfig, run: () => void): void {
  const values = {
    REVIEW_CONFIG_JSON: JSON.stringify(config),
    REVIEW_CANDIDATES_PATH: "/tmp/task16/candidates.json",
    REVIEW_VALIDATED_PATH: "/tmp/task16/validated.json",
    REVIEW_PRIOR_FINDINGS_PATH: "/tmp/task16/prior.json",
    SECURITY_REVIEW_ENABLED: "true",
    // The immutable config must win over conflicting ambient policy.
    REVIEW_SUGGEST_REVIEWERS: String(!config.review_suggest_reviewers),
    SECURITY_BLOCK_ON_CRITICAL: String(!config.security_block_on_critical),
    SECURITY_BLOCK_ON_HIGH: String(!config.security_block_on_high),
  };
  const saved = new Map(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, values);
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function expectedModelSettings(config: ReviewUxConfig) {
  return {
    depth: config.review_depth,
    diagram: config.review_diagram,
    effort: config.review_effort,
    ignorePaths: config.review_ignore_paths,
    severityThreshold: config.review_severity_threshold,
    securitySeverityThreshold: config.security_severity_threshold,
  };
}

function settingsBlock(prompt: string): unknown {
  const section = /### Effective review settings[^\n]*\n\n~~~json\n([\s\S]*?)\n~~~/.exec(
    prompt,
  );
  if (!section) throw new Error("Missing actual effective-settings JSON block");
  return JSON.parse(section[1]!);
}

function finding(level: ReviewFinding["securitySeverity"]): ReviewFinding {
  return {
    id: `security-${level}`,
    title: "Requests reach an unguarded privileged path",
    severity: "P2",
    category: "security",
    security: true,
    securitySeverity: level,
    path: "src/api.ts",
    line: 42,
    startLine: null,
    side: "RIGHT",
    also_at: [],
    body: "A request bypasses authorization on the changed path.",
    why: "The changed handler omits the existing authorization guard.",
    verification: "The synthetic code trace reaches the privileged call.",
    agent_prompt: "Verify the guard and add a regression test.",
    outside_diff: false,
    state: "open",
  };
}

const scenarios = [
  { name: "defaults", config: resolveReviewUxConfig({}) },
  ...Array.from({ length: 16 }, (_, bits) => ({
    name: `nondefault-policy-${bits}`,
    config: resolveReviewUxConfig({
      fileConfig: {
        review_depth: "shallow",
        review_diagram: "off",
        review_effort: true,
        review_ignore_paths: ["generated/**", "docs/évidence/**"],
        review_severity_threshold: "P1",
        security_severity_threshold: "high",
        review_suggest_reviewers: Boolean(bits & 1),
        review_pre_merge_checks:
          bits & 2 ? ["title", "description", "linked_issue"] : [],
        security_block_on_critical: Boolean(bits & 4),
        security_block_on_high: Boolean(bits & 8),
      },
    }),
  })),
];

const measurements: Array<{
  scenario: string;
  prompts: Record<string, string>;
  fullSettingsControls: Record<string, string>;
  runtime?: { summary: unknown; rendered: string; conclusions: unknown };
}> = [];

afterAll(() => {
  const output = process.env.TASK16_MEASUREMENTS_PATH;
  if (output) writeFileSync(output, JSON.stringify(measurements, null, 2));
});

describe("GitHub-only model settings projection", () => {
  for (const { name, config } of scenarios) {
    it(`${name}: removes only runtime-owned members from the real GitHub adapters`, () => {
      withConfig(config, () => {
        const originalConfig = process.env.REVIEW_CONFIG_JSON;
        const full = reviewPromptSettingsFromEnvironment();
        const expected = expectedModelSettings(config);
        const shared = {
          terminology: GITHUB_TERMINOLOGY,
          postingMode: "file" as const,
          entityNumber: "42",
          repoOrProject: "example/repo",
          headRef: "feature",
          headSha: head,
          baseRef: "main",
          ...artifacts,
          candidatesPath: "/tmp/task16/candidates.json",
          validatedPath: "/tmp/task16/validated.json",
          includeSuggestions: true,
          securityReviewEnabled: true,
          priorFindingsPath: "/tmp/task16/prior.json",
          repoGuidelines: context.reviewGuidelines,
        };
        const gl = {
          projectPath: "example/repo",
          mrIid: 42,
          mrTitle: "Preserve retry behavior",
          sourceBranch: "feature",
          targetBranch: "main",
          headSha: head,
          ...artifacts,
          candidatesPath: shared.candidatesPath,
          validatedPath: shared.validatedPath,
          includeSuggestions: true,
          securityReviewEnabled: true,
          reviewSettings: full,
        };
        const legacy = {
          sourceBranch: "feature",
          targetBranch: "main",
          headSha: head,
          ...artifacts,
          candidatesPath: shared.candidatesPath,
          validatedPath: shared.validatedPath,
          includeSuggestions: true,
          securityReviewEnabled: true,
        };
        const prompts = {
          "code-candidates": generateReviewCandidatesPrompt(context),
          "code-validator": generateReviewValidatorPrompt(context),
          "security-validator": generateReviewValidatorPrompt({
            ...context,
            eventData: {
              eventName: "issue_comment",
              commentId: "7",
              commentBody: "@droid security",
              isPR: true,
              prNumber: "42",
              baseBranch: "main",
            },
          }),
          "security-candidates": generateSecurityCandidatesPrompt(context),
          "gitlab-candidates": generateGitlabReviewCandidatesPrompt(gl),
          "gitlab-validator": generateGitlabReviewValidatorPrompt(gl),
          "bitbucket-candidates": generateBitbucketCandidatesPrompt({
            ...legacy,
            repoFullName: "example/repo",
            prId: 42,
          }),
          "bitbucket-validator": generateBitbucketValidatorPrompt({
            ...legacy,
            repoFullName: "example/repo",
            prId: 42,
          }),
          "azure-candidates": generateAzureDevopsCandidatesPrompt({
            ...legacy,
            repository: "example/repo",
            pullRequestId: 42,
          }),
          "azure-validator": generateAzureDevopsValidatorPrompt({
            ...legacy,
            repository: "example/repo",
            pullRequestId: 42,
          }),
        };
        measurements.push({
          scenario: name,
          prompts,
          fullSettingsControls: {
            "code-candidates": generateCandidatesPrompt({
              ...shared,
              reviewSettings: full,
            }),
            "code-validator": generateValidatorPrompt({
              ...shared,
              reviewSettings: full,
            }),
          },
        });

        expect(full).toEqual({
          depth: config.review_depth,
          diagram: config.review_diagram,
          effort: config.review_effort,
          suggestReviewers: config.review_suggest_reviewers,
          preMergeChecks: config.review_pre_merge_checks,
          ignorePaths: config.review_ignore_paths,
          severityThreshold: config.review_severity_threshold,
          securitySeverityThreshold: config.security_severity_threshold,
          securityBlockOnCritical: config.security_block_on_critical,
          securityBlockOnHigh: config.security_block_on_high,
        });
        expect(reviewConfigFromEnvironment()).toEqual(config);
        expect(process.env.REVIEW_CONFIG_JSON).toBe(originalConfig);

        for (const stage of [
          "code-candidates",
          "code-validator",
          "security-validator",
        ] as const) {
          expect(settingsBlock(prompts[stage])).toEqual(expected);
        }
        expect(prompts["code-candidates"]).toBe(
          generateCandidatesPrompt({ ...shared, reviewSettings: expected }),
        );
        const expectedValidator = generateValidatorPrompt({
          ...shared,
          reviewSettings: expected,
        });
        expect(prompts["code-validator"]).toBe(expectedValidator);
        expect(prompts["security-validator"]).toBe(expectedValidator);
        expect(prompts["code-validator"]).toContain(
          "Runtime enrichment owns file counts, CODEOWNERS reviewer",
        );
        expect(prompts["code-validator"]).toContain(
          "suggestions, configured pre-merge checks, and trusted security settings.",
        );
        expect(prompts["security-candidates"]).not.toContain(
          "### Effective review settings",
        );
        expect(settingsBlock(prompts["gitlab-candidates"])).toEqual(full);
        expect(settingsBlock(prompts["gitlab-validator"])).toEqual(full);
      });
    });

    it(`${name}: retains trusted metadata rendering and native policy outcomes`, () => {
      withConfig(config, () => {
        // Exercise the real model-facing adapter before the runtime consumers.
        generateReviewCandidatesPrompt(context);
        generateReviewValidatorPrompt(context);
        const runtime = reviewConfigFromEnvironment();
        const summary = enrichReviewSummary(
          {
            suggestedReviewers: ["invented"],
            preMergeChecks: [{ name: "invented", passed: true }],
            effort: { score: 3 },
          },
          {
            changedPaths: ["src/api.ts"],
            title: "Preserve the authorization guard",
            description: "Fixes #123 and preserves the existing runtime policy.",
            codeowners: "/src/ @org/security",
            suggestReviewers: runtime.review_suggest_reviewers,
            includeEffort: runtime.review_effort,
            preMergeChecks: runtime.review_pre_merge_checks,
            security: {
              enabled: true,
              threshold: runtime.security_severity_threshold,
              blockOnCritical: runtime.security_block_on_critical,
              blockOnHigh: runtime.security_block_on_high,
            },
          },
        );
        expect(runtime).toEqual(config);
        expect(summary.suggestedReviewers).toEqual(
          config.review_suggest_reviewers ? ["org/security"] : undefined,
        );
        expect(summary.preMergeChecks?.map((check) => check.passed)).toEqual(
          config.review_pre_merge_checks.length ? [true, true, true] : undefined,
        );
        expect(summary.effort).toEqual(
          config.review_effort ? { score: 3 } : undefined,
        );
        expect(summary.security).toEqual({
          enabled: true,
          threshold: config.security_severity_threshold,
          blockOnCritical: config.security_block_on_critical,
          blockOnHigh: config.security_block_on_high,
        });
        const policy = {
          failOnSeverity: runtime.fail_on_severity,
          securityBlockOnCritical: runtime.security_block_on_critical,
          securityBlockOnHigh: runtime.security_block_on_high,
        };
        const conclusions = {
          empty: reviewCheckConclusion([], policy),
          critical: reviewCheckConclusion([finding("critical")], policy),
          high: reviewCheckConclusion([finding("high")], policy),
          medium: reviewCheckConclusion([finding("medium")], policy),
          resolved: reviewCheckConclusion(
            [{ ...finding("critical"), state: "resolved" }],
            policy,
          ),
          dismissed: reviewCheckConclusion(
            [{ ...finding("critical"), state: "dismissed" }],
            policy,
          ),
          failed: reviewCheckConclusion([finding("critical")], policy, true),
        };
        expect(conclusions).toEqual({
          empty: "success",
          critical:
            config.security_block_on_critical || config.security_block_on_high
              ? "failure"
              : "neutral",
          high: config.security_block_on_high ? "failure" : "neutral",
          medium: "neutral",
          resolved: "success",
          dismissed: "success",
          failed: "neutral",
        });
        const rendered = renderReviewSummary({
          state: "findings",
          findings: [finding("medium")],
          summary,
          platform: "github",
          badges: "text",
          head,
        });
        expect(rendered.includes("Suggested reviewers (not assigned)")).toBe(
          config.review_suggest_reviewers,
        );
        expect(rendered.includes("Pre-merge checks:")).toBe(
          config.review_pre_merge_checks.length > 0,
        );
        const measurement = measurements.find((row) => row.scenario === name);
        if (!measurement) throw new Error("Missing rendered-prompt measurement");
        measurement.runtime = { summary, rendered, conclusions };
      });
    });
  }
});
