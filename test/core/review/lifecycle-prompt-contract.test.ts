import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  generateBitbucketCandidatesPrompt,
  generateBitbucketValidatorPrompt,
} from "../../../src/bitbucket/prompts";
import {
  generateAzureDevopsCandidatesPrompt,
  generateAzureDevopsValidatorPrompt,
} from "../../../src/azure-devops/prompts";
import { parseValidatedReview } from "../../../src/core/review/validated/parse";
import { reconcileFindings } from "../../../src/core/review/incremental";
import { reviewCheckConclusion } from "../../../src/github/operations/review-checks";

describe("lifecycle fields through existing parser and deterministic policy", () => {
  function parse(
    securitySeverity: "critical" | "high" | "medium" | "low",
    resolutions: unknown[] = [],
  ) {
    return parseValidatedReview(
      JSON.stringify({
        version: 1,
        meta: { headSha: "abcdef1234567890" },
        results: [
          {
            status: "approved",
            comment: {
              id: "stable-security",
              severity: "P2",
              security: true,
              securitySeverity,
              path: "src/auth.ts",
              line: 8,
              side: "RIGHT",
              body: "[P2] [security] Check authorization\n\nVerified bypass.",
            },
          },
        ],
        findingResolutions: resolutions,
      }),
    );
  }

  it("preserves stable IDs and classifies security independently of P2 priority", () => {
    for (const securitySeverity of [
      "critical",
      "high",
      "medium",
      "low",
    ] as const) {
      const result = parse(securitySeverity);
      expect(result.approved[0]?.finding).toMatchObject({
        id: "stable-security",
        severity: "P2",
        security: true,
        securitySeverity,
      });
      expect(
        reviewCheckConclusion(result.findings, {
          securityBlockOnCritical: false,
          securityBlockOnHigh: true,
        }),
      ).toBe(
        securitySeverity === "critical" || securitySeverity === "high"
          ? "failure"
          : "neutral",
      );
    }
    expect(reviewCheckConclusion(parse("critical").findings)).toBe("failure");
    expect(
      reviewCheckConclusion(parse("critical").findings, {
        securityBlockOnCritical: false,
        securityBlockOnHigh: false,
      }),
    ).toBe("neutral");
    expect(
      reviewCheckConclusion(parse("low").findings, { failOnSeverity: "P1" }),
    ).toBe("neutral");
    expect(
      reviewCheckConclusion(parse("low").findings, { failOnSeverity: "P2" }),
    ).toBe("failure");
  });

  it("requires separate fix evidence and actual changed-finding eligibility", () => {
    const finding = parse("high").findings[0];
    if (!finding) throw new Error("fixture finding missing");
    const result = parse("high", [
      {
        id: finding.id,
        status: "fixed",
        evidence: "Current head rejects bypass.",
      },
      { id: "no-evidence", status: "fixed", evidence: "" },
      { id: "still-open", status: "open", evidence: "Still vulnerable." },
    ]);
    const fixedIds = result.fixedFindings.map((finding) => finding.id);
    expect(fixedIds).toEqual([finding.id]);
    expect(result.approved).toHaveLength(1);
    const reconcile = (eligibleFixedIds: string[], fixedIds: string[]) =>
      reconcileFindings({
        previous: [{ ...finding, state: "open" }],
        current: [],
        eligibleFixedIds,
        fixedIds,
        head: "abcdef1234567890",
      });
    expect(reconcile([], fixedIds).resolved).toEqual([]);
    expect(reconcile([finding.id], []).resolved).toEqual([]);
    expect(reconcile([finding.id], fixedIds).resolved).toHaveLength(1);
    expect(
      reconcileFindings({
        previous: [{ ...finding, state: "dismissed" }],
        current: [],
        eligibleFixedIds: [finding.id],
        fixedIds,
        head: "abcdef1234567890",
      }).resolved,
    ).toEqual([]);
  });
});

describe("legacy platform prompt byte contracts", () => {
  for (const includeSuggestions of [false, true]) {
    for (const securityReviewEnabled of [false, true]) {
      const shared = {
        sourceBranch: "feature",
        targetBranch: "main",
        headSha: "abcdef1234567890",
        diffPath: "/tmp/review/pr.diff",
        commentsPath: "/tmp/review/comments.json",
        descriptionPath: "/tmp/review/description.txt",
        candidatesPath: "/tmp/review/candidates.json",
        validatedPath: "/tmp/review/validated.json",
        includeSuggestions,
        securityReviewEnabled,
      };
      const digest = (prompt: string) =>
        createHash("sha256").update(prompt).digest("hex");
      for (const diffTruncated of [false, true]) {
        it(`Bitbucket Cloud/Data Center suggestions=${includeSuggestions} security=${securityReviewEnabled} truncated=${diffTruncated}`, () => {
          const ctx = {
            ...shared,
            repoFullName: "workspace/repo",
            prId: 42,
            diffTruncated,
          };
          expect(
            digest(generateBitbucketCandidatesPrompt(ctx)),
          ).toMatchSnapshot();
          expect(
            digest(generateBitbucketValidatorPrompt(ctx)),
          ).toMatchSnapshot();
        });
      }
      it(`Azure DevOps suggestions=${includeSuggestions} security=${securityReviewEnabled}`, () => {
        const ctx = {
          ...shared,
          repository: "project/repo",
          pullRequestId: 42,
        };
        expect(
          digest(generateAzureDevopsCandidatesPrompt(ctx)),
        ).toMatchSnapshot();
        expect(
          digest(generateAzureDevopsValidatorPrompt(ctx)),
        ).toMatchSnapshot();
      });
    }
  }
});
