import type { PreparedContext } from "../types";
import type { ScanScope } from "../../tag/commands/security-scan";

export function generateSecurityReportPrompt(
  context: PreparedContext,
  scanScope: ScanScope,
  branchName: string,
): string {
  const date = new Date().toISOString().split("T")[0];
  const repoFullName = context.repository;

  const scopeDescription =
    scanScope.type === "full"
      ? "Entire repository"
      : `Last ${scanScope.days} days of commits`;

  const scanTypeLabel =
    scanScope.type === "full" ? "Full Repository" : "Weekly Scheduled";

  const scanInstructions =
    scanScope.type === "full"
      ? `- Scan all source files in the repository
- Focus on: TypeScript, JavaScript, Python, Go, Java, Ruby, PHP files
- Use: \`find . -type f \\( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.go" -o -name "*.java" -o -name "*.rb" -o -name "*.php" \\) -not -path "./node_modules/*" -not -path "./.git/*"\``
      : `- Get commits from the last ${scanScope.days} days: \`git log --since="${scanScope.days} days ago" --name-only --pretty=format:""\`
- Focus analysis on files changed in recent commits
- Scan each changed file for security vulnerabilities`;

  // Extract security configuration from context
  const securityConfig = context.githubContext?.inputs;
  const severityThreshold =
    securityConfig?.securitySeverityThreshold ?? "medium";
  const notifyTeam = securityConfig?.securityNotifyTeam ?? "";

  return `You are performing a ${scanTypeLabel.toLowerCase()} security scan for ${repoFullName}.
The gh CLI is installed and authenticated via GH_TOKEN.

## Scan Configuration
- Scope: ${scopeDescription}
- Severity Threshold: ${severityThreshold} (only report findings at or above this level)
- Output Branch: ${branchName}
- Report Path: .factory/security/reports/security-report-${date}.md

## Security Skills Available

You have access to these Factory security skills (installed in ~/.factory/skills/):

1. **threat-model-generation** - Generate STRIDE-based threat model for the repository
2. **commit-security-scan** - Scan code for security vulnerabilities
3. **vulnerability-validation** - Validate findings, assess exploitability, filter false positives
4. **security-patch-generation** - Generate secure code fixes for confirmed vulnerabilities

## Workflow

### Step 1: Create Branch
\`\`\`bash
git checkout -b ${branchName}
\`\`\`

### Step 2: Threat Model Check
- Check if \`.factory/threat-model.md\` exists in the repository
- If missing: Invoke the **threat-model-generation** skill to create one
- If exists: Check the file's last modified date
  - If >90 days old: Regenerate and update the threat model
  - If current: Use it as context for the security scan

### Step 3: Security Scan
${scanInstructions}

For each file:
- Invoke the **commit-security-scan** skill
- Look for STRIDE vulnerabilities (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege)

### Step 4: Validate Findings
- For each finding from Step 3, invoke the **vulnerability-validation** skill
- Assess:
  - Reachability: Is the vulnerable code reachable from user input?
  - Exploitability: How easy is it to exploit?
  - Impact: What's the potential damage?
- Filter out false positives and findings below the severity threshold (${severityThreshold})

### Step 5: Generate Patches
- For each confirmed finding that can be auto-fixed:
  - Invoke **security-patch-generation** skill
  - Apply the patch to the codebase
  - Commit the fix with message: \`fix(security): [VULN-XXX] Brief description\`

### Step 6: Generate Report
- Create directory: \`mkdir -p .factory/security/reports\`
- Write report to: \`.factory/security/reports/security-report-${date}.md\`

### Step 7: Create PR
\`\`\`bash
git add .
git commit -m "fix(security): Security scan report - ${date}"
git push origin ${branchName}
gh pr create --title "fix(security): Security scan report - ${date} (N findings)" \\
  --body "## Security Scan Report

See \`.factory/security/reports/security-report-${date}.md\` for details.

### Summary
| Severity | Count | Auto-fixed | Manual Required |
|----------|-------|------------|-----------------|
| CRITICAL | X | X | X |
| HIGH | X | X | X |
| MEDIUM | X | X | X |
| LOW | X | X | X |

${notifyTeam ? `cc ${notifyTeam}` : ""}"
\`\`\`

## Report Format

The report file should follow this structure:

\`\`\`markdown
# Security Scan Report

**Generated:** ${date}
**Scan Type:** ${scanTypeLabel}
**Repository:** ${repoFullName}
**Severity Threshold:** ${severityThreshold}

## Executive Summary

| Severity | Count | Auto-fixed | Manual Required |
|----------|-------|------------|-----------------|
| CRITICAL | X | X | X |
| HIGH | X | X | X |
| MEDIUM | X | X | X |
| LOW | X | X | X |

**Total Findings:** X
**Auto-fixed:** X
**Manual Review Required:** X

## Critical Findings

### VULN-001: [Vulnerability Title]

| Attribute | Value |
|-----------|-------|
| **Severity** | CRITICAL |
| **STRIDE Category** | [Tampering/Spoofing/etc] |
| **CWE** | CWE-XXX |
| **File** | path/to/file.ts:line |
| **Status** | Patched / Manual fix required |

**Description:**
[Clear explanation of the vulnerability]

**Evidence:**
\\\`\\\`\\\`
[Code snippet showing the vulnerability]
\\\`\\\`\\\`

**Fix Applied:** (if auto-patched)
\\\`\\\`\\\`diff
- vulnerable code
+ secure code
\\\`\\\`\\\`

**Recommended Fix:** (if manual)
[Step-by-step remediation guidance]

---

## High Findings
[Same format as Critical]

## Medium Findings
[Same format as Critical]

## Low Findings
[Same format as Critical]

## Appendix

### Threat Model
- Version: [date or "newly generated"]
- Location: .factory/threat-model.md

### Scan Metadata
- ${scanScope.type === "full" ? "Files" : "Commits"} Scanned: N
- Scan Duration: Xm Ys
- Skills Used: threat-model-generation, commit-security-scan, vulnerability-validation, security-patch-generation

### References
- [CWE Database](https://cwe.mitre.org/)
- [STRIDE Threat Model](https://docs.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats)
\`\`\`

## Severity Definitions

| Severity | Criteria | Examples |
|----------|----------|----------|
| **CRITICAL** | Immediately exploitable, high impact, no auth required | RCE, hardcoded secrets, auth bypass |
| **HIGH** | Exploitable with conditions, significant impact | SQL injection, stored XSS, IDOR |
| **MEDIUM** | Requires specific conditions, moderate impact | CSRF, info disclosure, missing rate limits |
| **LOW** | Difficult to exploit, low impact | Verbose errors, missing security headers |

## Important Notes

1. **Accuracy**: Only report high-confidence findings. False positives waste developer time.
2. **Patches**: Test all generated patches before committing. Ensure they don't break functionality.
3. **PR Description**: Update the PR body with actual finding counts before creating.
4. **Commit Messages**: Use semantic commit format: \`fix(security): [VULN-XXX] Description\`
`;
}
