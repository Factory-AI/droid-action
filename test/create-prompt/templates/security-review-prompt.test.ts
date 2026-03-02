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
    expect(prompt).toContain("security-review");
    expect(prompt).toContain("## Review Workflow");
    expect(prompt).toContain("gh pr diff 42 --repo test-owner/test-repo");
    expect(prompt).toContain(
      "gh api repos/test-owner/test-repo/pulls/42/files",
    );
    expect(prompt).toContain("security-review-results.json");
    expect(prompt).toContain("Do NOT post inline comments");
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

  it("uses outputFilePath when provided", () => {
    const context = createBaseContext({
      outputFilePath: "/tmp/results/security-results.json",
    });

    const prompt = generateSecurityReviewPrompt(context);

    expect(prompt).toContain("/tmp/results/security-results.json");
    expect(prompt).not.toContain(
      "Write findings to `security-review-results.json`",
    );
  });

  it("falls back to default filename when outputFilePath is not set", () => {
    const context = createBaseContext();

    const prompt = generateSecurityReviewPrompt(context);

    expect(prompt).toContain("security-review-results.json");
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

  it("includes review guidelines when provided", () => {
    const context = createBaseContext({
      reviewGuidelines:
        "- Always check for SQL injection\n- Verify CORS settings",
    });

    const prompt = generateSecurityReviewPrompt(context);

    expect(prompt).toContain("## Repository Review Guidelines");
    expect(prompt).toContain("- Always check for SQL injection");
    expect(prompt).toContain("- Verify CORS settings");
  });

  it("does not include review guidelines section when not provided", () => {
    const context = createBaseContext();

    const prompt = generateSecurityReviewPrompt(context);

    expect(prompt).not.toContain("## Repository Review Guidelines");
  });
});
