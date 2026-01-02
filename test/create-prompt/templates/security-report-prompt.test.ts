import { describe, expect, test } from "bun:test";
import { generateSecurityReportPrompt } from "../../../src/create-prompt/templates/security-report-prompt";
import type { PreparedContext } from "../../../src/create-prompt/types";

describe("generateSecurityReportPrompt", () => {
  const baseContext: PreparedContext = {
    repository: "test-owner/test-repo",
    triggerPhrase: "@droid",
    eventData: {
      eventName: "issue_comment",
      commentId: "123",
      issueNumber: "1",
      isPR: false,
      baseBranch: "main",
      droidBranch: "droid/security-report-2024-01-15",
      commentBody: "@droid security --full",
    },
    githubContext: {
      runId: "1234567890",
      eventName: "issue_comment",
      eventAction: "created",
      repository: {
        owner: "test-owner",
        repo: "test-repo",
        full_name: "test-owner/test-repo",
      },
      actor: "test-user",
      payload: {} as any,
      entityNumber: 1,
      isPR: false,
      inputs: {
        triggerPhrase: "@droid",
        assigneeTrigger: "",
        labelTrigger: "",
        useStickyComment: false,
        allowedBots: "",
        allowedNonWriteUsers: "",
        trackProgress: false,
        automaticReview: false,
        automaticSecurityReview: false,
        securityModel: "",
        securitySeverityThreshold: "high",
        securityBlockOnCritical: true,
        securityBlockOnHigh: false,
        securityNotifyTeam: "@org/security-team",
        securityScanSchedule: false,
        securityScanDays: 7,
      },
    },
  };

  test("includes scan configuration for full repository scan", () => {
    const prompt = generateSecurityReportPrompt(
      baseContext,
      { type: "full" },
      "droid/security-report-2024-01-15",
    );

    expect(prompt).toContain("full repository");
    expect(prompt).toContain("Entire repository");
    expect(prompt).toContain("droid/security-report-2024-01-15");
    expect(prompt).toContain(".factory/security/reports/security-report-");
  });

  test("includes scan configuration for scheduled scan", () => {
    const prompt = generateSecurityReportPrompt(
      baseContext,
      { type: "scheduled", days: 7 },
      "droid/security-report-2024-01-15",
    );

    expect(prompt).toContain("weekly scheduled");
    expect(prompt).toContain("Last 7 days of commits");
    expect(prompt).toContain("git log --since=");
  });

  test("includes security skills workflow", () => {
    const prompt = generateSecurityReportPrompt(
      baseContext,
      { type: "full" },
      "droid/security-report-2024-01-15",
    );

    expect(prompt).toContain("threat-model-generation");
    expect(prompt).toContain("commit-security-scan");
    expect(prompt).toContain("vulnerability-validation");
    expect(prompt).toContain("security-patch-generation");
  });

  test("includes PR creation instructions", () => {
    const prompt = generateSecurityReportPrompt(
      baseContext,
      { type: "full" },
      "droid/security-report-2024-01-15",
    );

    expect(prompt).toContain("git checkout -b");
    expect(prompt).toContain("git push origin");
    expect(prompt).toContain("gh pr create");
    expect(prompt).toContain("fix(security):");
  });

  test("includes report format template", () => {
    const prompt = generateSecurityReportPrompt(
      baseContext,
      { type: "full" },
      "droid/security-report-2024-01-15",
    );

    expect(prompt).toContain("# Security Scan Report");
    expect(prompt).toContain("Executive Summary");
    expect(prompt).toContain(
      "| Severity | Count | Auto-fixed | Manual Required |",
    );
    expect(prompt).toContain("VULN-001");
    expect(prompt).toContain("STRIDE");
    expect(prompt).toContain("CWE");
  });

  test("includes severity definitions", () => {
    const prompt = generateSecurityReportPrompt(
      baseContext,
      { type: "full" },
      "droid/security-report-2024-01-15",
    );

    expect(prompt).toContain("CRITICAL");
    expect(prompt).toContain("HIGH");
    expect(prompt).toContain("MEDIUM");
    expect(prompt).toContain("LOW");
    expect(prompt).toContain("Immediately exploitable");
  });

  test("includes security configuration from context", () => {
    const prompt = generateSecurityReportPrompt(
      baseContext,
      { type: "full" },
      "droid/security-report-2024-01-15",
    );

    expect(prompt).toContain("Severity Threshold: high");
    expect(prompt).toContain("@org/security-team");
  });

  test("includes threat model check instructions", () => {
    const prompt = generateSecurityReportPrompt(
      baseContext,
      { type: "full" },
      "droid/security-report-2024-01-15",
    );

    expect(prompt).toContain(".factory/threat-model.md");
    expect(prompt).toContain("Threat Model Check");
    expect(prompt).toContain("90 days old");
  });
});
