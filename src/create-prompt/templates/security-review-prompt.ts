import type { PreparedContext } from "../types";

export function generateSecurityReviewPrompt(context: PreparedContext): string {
  const prNumber = context.eventData.isPR
    ? context.eventData.prNumber
    : context.githubContext && "entityNumber" in context.githubContext
      ? String(context.githubContext.entityNumber)
      : "unknown";

  const repoFullName = context.repository;
  const headRefName = context.prBranchData?.headRefName ?? "unknown";
  const headSha = context.prBranchData?.headRefOid ?? "unknown";
  const baseRefName = context.eventData.baseBranch ?? "unknown";

  // Extract security configuration from context
  const securityConfig = context.githubContext?.inputs;
  const severityThreshold =
    securityConfig?.securitySeverityThreshold ?? "medium";
  const blockOnCritical = securityConfig?.securityBlockOnCritical ?? true;
  const blockOnHigh = securityConfig?.securityBlockOnHigh ?? false;
  const notifyTeam = securityConfig?.securityNotifyTeam ?? "";

  return `You are performing a security-focused code review for PR #${prNumber} in ${repoFullName}.
The gh CLI is installed and authenticated via GH_TOKEN.

## Context
- Repo: ${repoFullName}
- PR Number: ${prNumber}
- PR Head Ref: ${headRefName}
- PR Head SHA: ${headSha}
- PR Base Ref: ${baseRefName}

## Security Configuration
- Severity Threshold: ${severityThreshold} (only report findings at or above this level)
- Block on Critical: ${blockOnCritical}
- Block on High: ${blockOnHigh}
${notifyTeam ? `- Notify Team: ${notifyTeam} (mention on critical findings)` : ""}

## Security Skills Available

You have access to these Factory security skills (installed in ~/.factory/skills/):

1. **threat-model-generation** - Generate STRIDE-based threat model for the repository
2. **commit-security-scan** - Scan code changes for security vulnerabilities
3. **vulnerability-validation** - Validate findings, assess exploitability, filter false positives
4. **security-review** - Comprehensive security review and patch generation

## Review Workflow

### Step 1: Threat Model Check
- Check if \`.factory/threat-model.md\` exists in the repository
- If missing: Invoke the **threat-model-generation** skill to create one, then commit it to the PR branch
- If exists: Check the file's last modified date
  - If >90 days old: Post a warning comment suggesting regeneration, but proceed with scan
  - If current: Use it as context for the security scan

### Step 2: Security Scan
- Invoke the **commit-security-scan** skill on the PR diff
- Gather the PR diff using: \`gh pr diff ${prNumber} --repo ${repoFullName}\`
- Get file changes: \`gh api repos/${repoFullName}/pulls/${prNumber}/files --paginate\`
- Focus analysis on:
  - New code introduced by this PR
  - Modified code that may introduce vulnerabilities
  - Changes that expose existing vulnerabilities

### Step 3: Validate Findings
- For each finding from Step 2, invoke the **vulnerability-validation** skill
- Assess:
  - Reachability: Is the vulnerable code reachable from user input?
  - Exploitability: How easy is it to exploit?
  - Impact: What's the potential damage?
- Filter out false positives and findings below the severity threshold (${severityThreshold})

### Step 4: Report & Patch
- For each confirmed finding at or above ${severityThreshold} severity:
  - Post inline comment using \`github_inline_comment___create_inline_comment\`
  - Include: severity, STRIDE category, CWE ID, clear explanation, suggested fix
- For auto-fixable issues: Invoke **security-review** skill to generate patches
- Commit any generated patches to the PR branch

## Security Scope (STRIDE Categories)

**Spoofing** (S):
- Weak authentication, session hijacking, token exposure

**Tampering** (T):
- SQL/NoSQL/command injection, XSS, mass assignment, unsafe deserialization

**Repudiation** (R):
- Missing audit logs, unsigned transactions

**Information Disclosure** (I):
- IDOR, verbose errors, hardcoded secrets, sensitive data in logs

**Denial of Service** (D):
- Missing rate limits, resource exhaustion, ReDoS

**Elevation of Privilege** (E):
- Missing authorization checks, role manipulation, privilege escalation

## Severity Definitions

| Severity | Criteria | Examples |
|----------|----------|----------|
| **CRITICAL** | Immediately exploitable, high impact, no auth required | RCE, hardcoded secrets, auth bypass |
| **HIGH** | Exploitable with conditions, significant impact | SQL injection, stored XSS, IDOR |
| **MEDIUM** | Requires specific conditions, moderate impact | CSRF, info disclosure, missing rate limits |
| **LOW** | Difficult to exploit, low impact | Verbose errors, missing security headers |

## Output Requirements

IMPORTANT: Do NOT post inline comments directly. Instead, write findings to a JSON file.
The finalize step will post all inline comments to avoid overlapping with code review comments.

1. Write findings to \`security-review-results.json\` with this structure:
\`\`\`json
{
  "type": "security",
  "findings": [
    {
      "id": "SEC-001",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "type": "SQL Injection",
      "stride": "T",
      "cwe": "CWE-89",
      "file": "path/to/file.ts",
      "line": 55,
      "side": "RIGHT",
      "description": "Brief description of the vulnerability",
      "suggestion": "Optional code fix"
    }
  ],
  "summary": "Brief overall summary",
  "block_pr": ${blockOnCritical || blockOnHigh ? "true if CRITICAL/HIGH found" : "false"}
}
\`\`\`

2. Update the tracking comment using \`github_comment___update_droid_comment\`

## Summary Format (for tracking comment update)

Use \`github_comment___update_droid_comment\` to update the tracking comment with this format:

\`\`\`markdown
## 🔐 Security Review Summary

| Severity | Count |
|----------|-------|
| 🚨 CRITICAL | X |
| 🔴 HIGH | X |
| 🟡 MEDIUM | X |
| 🟢 LOW | X |

### Findings
| ID | Severity | Type | File | Line | Reference |
|----|----------|------|------|------|-----------|
| SEC-001 | CRITICAL | SQL Injection | auth.ts | 55 | [CWE-89](https://cwe.mitre.org/data/definitions/89.html) |
| SEC-002 | HIGH | XSS | client.ts | 98 | [CWE-79](https://cwe.mitre.org/data/definitions/79.html) |

${notifyTeam ? `cc ${notifyTeam}` : ""}
\`\`\`

## Accuracy Requirements

- Base findings strictly on the current diff and repository context
- False positives are very costly—only report high-confidence findings
- If confidence is low, ask a clarifying question instead of asserting a vulnerability
- Never raise purely stylistic concerns
- Cap at 10 inline comments total
`;
}
