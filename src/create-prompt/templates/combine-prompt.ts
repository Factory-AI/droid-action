import type { PreparedContext } from "../types";

export function generateCombinePrompt(
  context: PreparedContext,
  codeReviewResultsPath: string,
  securityResultsPath: string,
): string {
  const prNumber = context.eventData.isPR
    ? context.eventData.prNumber
    : context.githubContext && "entityNumber" in context.githubContext
      ? String(context.githubContext.entityNumber)
      : "unknown";

  const repoFullName = context.repository;

  return `You are combining code review and security review results for PR #${prNumber} in ${repoFullName}.
The gh CLI is installed and authenticated via GH_TOKEN.

## Context
- Repo: ${repoFullName}
- PR Number: ${prNumber}
- Code Review Results: ${codeReviewResultsPath}
- Security Review Results: ${securityResultsPath}

## Task

1. Read the results files (if they exist):
   - ${codeReviewResultsPath} - Code review findings
   - ${securityResultsPath} - Security review findings

2. Combine and deduplicate findings:
   - Merge findings from both reviews
   - Remove duplicates (same file + line + similar description)
   - Prioritize security findings over code review findings for overlaps

3. Post inline comments for all unique findings using github_inline_comment___create_inline_comment:
   - Use side="RIGHT" for new/modified code
   - Include severity, description, and suggested fix where available
   - For security findings, include CWE reference

4. Update the tracking comment with combined summary using github_comment___update_droid_comment:

IMPORTANT: Do NOT use github_pr___submit_review. Only update the tracking comment and post inline comments.
The tracking comment IS the summary - do not create any other summary comments.

\`\`\`markdown
## Code review completed

### Code Review
| Category | Count |
|----------|-------|
| 🐛 Bugs | X |
| ⚠️ Issues | X |
| 💡 Suggestions | X |

### Security Review
| Severity | Count |
|----------|-------|
| 🚨 CRITICAL | X |
| 🔴 HIGH | X |
| 🟡 MEDIUM | X |
| 🟢 LOW | X |

### Findings
| ID | Type | Severity | File | Line | Description |
|----|------|----------|------|------|-------------|
| ... | ... | ... | ... | ... | ... |

[View workflow run](link)
\`\`\`

## Available Tools
- github_comment___update_droid_comment - Update tracking comment (this is the ONLY place for the summary)
- github_inline_comment___create_inline_comment - Post inline comments on specific lines
- Read, Grep, Glob, LS, Execute - File operations

DO NOT use github_pr___submit_review - it creates duplicate summary comments.

## Important
- If no results files exist or they're empty, report "No issues found"
- Maximum 10 inline comments total
- Deduplicate findings that appear in both reviews
`;
}
