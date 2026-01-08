import type { PreparedContext } from "../types";

export function generateCombinePrompt(
  context: PreparedContext,
  codeReviewResultsPath: string,
): string {
  const prNumber = context.eventData.isPR
    ? context.eventData.prNumber
    : context.githubContext && "entityNumber" in context.githubContext
      ? String(context.githubContext.entityNumber)
      : "unknown";

  const repoFullName = context.repository;

  return `You are combining code review results for PR #${prNumber} in ${repoFullName}.
The gh CLI is installed and authenticated via GH_TOKEN.

## Context
- Repo: ${repoFullName}
- PR Number: ${prNumber}
- Code Review Results: ${codeReviewResultsPath}

## Task

1. Read the results file (if it exists):
   - ${codeReviewResultsPath} - Code review findings

2. Post inline comments for all findings using github_inline_comment___create_inline_comment:
   - Use side="RIGHT" for new/modified code
   - Include severity, description, and suggested fix where available

3. Analyze the PR diff to generate:
   - A concise 1-2 sentence summary of what the PR does
   - 3-5 key changes extracted from the diff
   - The most important files changed (up to 5-7 files)

4. Update the tracking comment with combined summary using github_comment___update_droid_comment:

IMPORTANT: Do NOT use github_pr___submit_review. Only update the tracking comment and post inline comments.
The tracking comment IS the summary - do not create any other summary comments.

\`\`\`markdown
## Code review completed

### Summary
{Brief 1-2 sentence description of what this PR does}

### Key Changes
- {Change 1}
- {Change 2}
- {Change 3}

### Important Files Changed
- \`path/to/file1.ts\` - {Brief description of changes}
- \`path/to/file2.ts\` - {Brief description of changes}

### Code Review
| Type | Count |
|------|-------|
| 🐛 Bugs | X |
| ⚠️ Issues | X |
| 💡 Suggestions | X |

### Findings
| ID | Type | Severity | File | Description |
|----|------|----------|------|-------------|
| ... | ... | ... | ... | ... |

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
`;
}
