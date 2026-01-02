import { describe, expect, it } from "bun:test";
import { generateSecurityReviewPrompt } from "../../../src/create-prompt/templates/security-review-prompt";
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
      commentBody: "@droid security-review",
    },
    githubContext: undefined,
    ...overrides,
  } as PreparedContext;
}

describe("generateSecurityReviewPrompt", () => {
  it("includes security context and skill workflow", () => {
    const prompt = generateSecurityReviewPrompt(createBaseContext());

    expect(prompt).toContain("security-focused code review");
    expect(prompt).toContain("## Security Skills Available");
    expect(prompt).toContain("threat-model-generation");
    expect(prompt).toContain("commit-security-scan");
    expect(prompt).toContain("vulnerability-validation");
    expect(prompt).toContain("security-patch-generation");
    expect(prompt).toContain("## Review Workflow");
    expect(prompt).toContain("gh pr diff 42 --repo test-owner/test-repo");
    expect(prompt).toContain(
      "gh api repos/test-owner/test-repo/pulls/42/files",
    );
    expect(prompt).toContain("github_inline_comment___create_inline_comment");
    expect(prompt).toContain("github_pr___submit_review");
  });

  it("lists STRIDE security categories", () => {
    const prompt = generateSecurityReviewPrompt(createBaseContext());

    expect(prompt).toContain("Spoofing");
    expect(prompt).toContain("Tampering");
    expect(prompt).toContain("Repudiation");
    expect(prompt).toContain("Information Disclosure");
    expect(prompt).toContain("Denial of Service");
    expect(prompt).toContain("Elevation of Privilege");
  });

  it("includes severity definitions", () => {
    const prompt = generateSecurityReviewPrompt(createBaseContext());

    expect(prompt).toContain("CRITICAL");
    expect(prompt).toContain("HIGH");
    expect(prompt).toContain("MEDIUM");
    expect(prompt).toContain("LOW");
  });

  it("includes security configuration from context", () => {
    const contextWithConfig = createBaseContext({
      githubContext: {
        inputs: {
          securitySeverityThreshold: "high",
          securityBlockOnCritical: true,
          securityBlockOnHigh: true,
          securityNotifyTeam: "@org/security-team",
        },
      } as any,
    });

    const prompt = generateSecurityReviewPrompt(contextWithConfig);

    expect(prompt).toContain("Severity Threshold: high");
    expect(prompt).toContain("Block on Critical: true");
    expect(prompt).toContain("Block on High: true");
    expect(prompt).toContain("@org/security-team");
  });
});
