#!/usr/bin/env bun

/**
 * Combine results from code review and security review into a single summary
 * Updates the tracking comment with the combined results
 */

import * as core from "@actions/core";
import { readFile } from "fs/promises";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext } from "../github/context";
import { GITHUB_SERVER_URL } from "../github/api/config";

interface ReviewFinding {
  id: string;
  type: string;
  severity?: string;
  file: string;
  line: number;
  description: string;
  cwe?: string;
}

interface ReviewResults {
  type: "code" | "security";
  findings: ReviewFinding[];
  summary?: string;
}

async function loadResults(filePath: string): Promise<ReviewResults | null> {
  if (!filePath || filePath === "") {
    return null;
  }

  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.warn(`Could not load results from ${filePath}:`, error);
    return null;
  }
}

function generateCombinedSummary(
  codeResults: ReviewResults | null,
  securityResults: ReviewResults | null,
  codeStatus: string,
  securityStatus: string,
  jobUrl: string,
): string {
  const sections: string[] = [];

  // Header
  sections.push("## 🔍 PR Review Summary\n");

  // Status overview
  const statusTable = ["| Review Type | Status |", "|-------------|--------|"];

  if (codeStatus !== "skipped") {
    const codeIcon = codeStatus === "success" ? "✅" : "❌";
    statusTable.push(`| Code Review | ${codeIcon} ${codeStatus} |`);
  }

  if (securityStatus !== "skipped") {
    const securityIcon = securityStatus === "success" ? "✅" : "❌";
    statusTable.push(`| Security Review | ${securityIcon} ${securityStatus} |`);
  }

  if (statusTable.length > 2) {
    sections.push(statusTable.join("\n"));
    sections.push("");
  }

  // Code Review Section
  if (codeResults && codeResults.findings.length > 0) {
    sections.push("### 📝 Code Review Findings\n");
    sections.push("| ID | Type | File | Line | Description |");
    sections.push("|----|------|------|------|-------------|");

    for (const finding of codeResults.findings.slice(0, 10)) {
      sections.push(
        `| ${finding.id} | ${finding.type} | \`${finding.file}\` | ${finding.line} | ${finding.description} |`,
      );
    }

    if (codeResults.findings.length > 10) {
      sections.push(
        `\n*...and ${codeResults.findings.length - 10} more findings*`,
      );
    }
    sections.push("");
  } else if (codeStatus === "success") {
    sections.push("### 📝 Code Review\n");
    sections.push("✅ No code quality issues found.\n");
  }

  // Security Review Section
  if (securityResults && securityResults.findings.length > 0) {
    sections.push("### 🔐 Security Review Findings\n");

    // Severity counts
    const severityCounts = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
    };

    for (const finding of securityResults.findings) {
      const sev = (finding.severity?.toUpperCase() ||
        "MEDIUM") as keyof typeof severityCounts;
      if (sev in severityCounts) {
        severityCounts[sev]++;
      }
    }

    sections.push("| Severity | Count |");
    sections.push("|----------|-------|");
    if (severityCounts.CRITICAL > 0)
      sections.push(`| 🚨 CRITICAL | ${severityCounts.CRITICAL} |`);
    if (severityCounts.HIGH > 0)
      sections.push(`| 🔴 HIGH | ${severityCounts.HIGH} |`);
    if (severityCounts.MEDIUM > 0)
      sections.push(`| 🟡 MEDIUM | ${severityCounts.MEDIUM} |`);
    if (severityCounts.LOW > 0)
      sections.push(`| 🟢 LOW | ${severityCounts.LOW} |`);
    sections.push("");

    // Findings table
    sections.push("| ID | Severity | Type | File | Line | Reference |");
    sections.push("|----|----------|------|------|------|-----------|");

    for (const finding of securityResults.findings.slice(0, 10)) {
      const cweLink = finding.cwe
        ? `[${finding.cwe}](https://cwe.mitre.org/data/definitions/${finding.cwe.replace("CWE-", "")}.html)`
        : "-";
      sections.push(
        `| ${finding.id} | ${finding.severity || "MEDIUM"} | ${finding.type} | \`${finding.file}\` | ${finding.line} | ${cweLink} |`,
      );
    }

    if (securityResults.findings.length > 10) {
      sections.push(
        `\n*...and ${securityResults.findings.length - 10} more findings*`,
      );
    }
    sections.push("");
  } else if (securityStatus === "success") {
    sections.push("### 🔐 Security Review\n");
    sections.push("✅ No security vulnerabilities found.\n");
  }

  // Footer with job link
  sections.push(`---\n[View job run](${jobUrl})`);

  return sections.join("\n");
}

async function run() {
  try {
    const githubToken = process.env.GITHUB_TOKEN!;
    const commentId = parseInt(process.env.DROID_COMMENT_ID || "0");
    const codeResultsPath = process.env.CODE_REVIEW_RESULTS || "";
    const securityResultsPath = process.env.SECURITY_RESULTS || "";
    const codeStatus = process.env.CODE_REVIEW_STATUS || "skipped";
    const securityStatus = process.env.SECURITY_REVIEW_STATUS || "skipped";
    const runId = process.env.GITHUB_RUN_ID || "";

    if (!commentId) {
      throw new Error("DROID_COMMENT_ID is required");
    }

    const context = parseGitHubContext();
    const { owner, repo } = context.repository;
    const octokit = createOctokit(githubToken);

    // Load results from artifacts
    const codeResults = await loadResults(codeResultsPath);
    const securityResults = await loadResults(securityResultsPath);

    // Generate job URL
    const jobUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${runId}`;

    // Generate combined summary
    const summary = generateCombinedSummary(
      codeResults,
      securityResults,
      codeStatus,
      securityStatus,
      jobUrl,
    );

    // Update the tracking comment
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body: summary,
    });

    console.log(
      `✅ Updated tracking comment ${commentId} with combined summary`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Combine reviews failed: ${errorMessage}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
