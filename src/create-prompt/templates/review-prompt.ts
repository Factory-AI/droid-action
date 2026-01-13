import type { PreparedContext } from "../types";

export function generateReviewPrompt(context: PreparedContext): string {
  const prNumber = context.eventData.isPR
    ? context.eventData.prNumber
    : context.githubContext && "entityNumber" in context.githubContext
      ? String(context.githubContext.entityNumber)
      : "unknown";

  const repoFullName = context.repository;
  const headRefName = context.prBranchData?.headRefName ?? "unknown";
  const headSha = context.prBranchData?.headRefOid ?? "unknown";
  const baseRefName = context.eventData.baseBranch ?? "unknown";

  return `You are performing an automated code review for PR #${prNumber} in ${repoFullName}.
The gh CLI is installed and authenticated via GH_TOKEN.

Context:
- Repo: ${repoFullName}
- PR Number: ${prNumber}
- PR Head Ref: ${headRefName}
- PR Head SHA: ${headSha}
- PR Base Ref: ${baseRefName}
- The PR branch has already been checked out. You have full access to read any file in the codebase, not just the diff output.

Objectives:
1) Review the PR diff and surface all bugs that meet the detection criteria below.
2) Output findings in JSON format for later processing (DO NOT post inline comments directly).
3) Update the tracking comment with a summary.

Procedure:
- Run: gh pr view ${prNumber} --repo ${repoFullName} --json comments,reviews
- Prefer reviewing the local git diff since the PR branch is already checked out:
  - Ensure you have the base branch ref locally (fetch if needed).
  - Find merge base between HEAD and the base branch.
  - Run git diff from that merge base to HEAD to see exactly what would merge.
  - Example:
    - git fetch origin ${baseRefName}:refs/remotes/origin/${baseRefName}
    - MERGE_BASE=$(git merge-base HEAD refs/remotes/origin/${baseRefName})
    - git diff $MERGE_BASE..HEAD
- Use gh PR diff/file APIs only as a fallback when local git diff is not possible:
  - gh pr diff ${prNumber} --repo ${repoFullName}
  - gh api repos/${repoFullName}/pulls/${prNumber}/files --paginate --jq '.[] | {filename,patch,additions,deletions}'
- Analyze the diff for issues
- Write findings to \`code-review-results.json\` in the current directory
- IMPORTANT: Do NOT delete comment ID ${context.droidCommentId} - this is the tracking comment for the current run.

IMPORTANT: Do NOT post inline comments directly. Instead, write findings to a JSON file.
The finalize step will post all inline comments to avoid overlapping with security review comments.

How Many Findings to Return:
Output all findings that the original author would fix if they knew about it. If there is no finding that a person would definitely love to see and fix, prefer outputting no findings. Do not stop at the first qualifying finding. Continue until you've listed every qualifying finding.

Key Guidelines for Bug Detection:
Only flag an issue as a bug if:
1. It meaningfully impacts the accuracy, performance, security, or maintainability of the code.
2. The bug is discrete and actionable (not a general issue).
3. Fixing the bug does not demand a level of rigor not present in the rest of the codebase.
4. The bug was introduced in the PR (pre-existing bugs should not be flagged).
5. The author would likely fix the issue if made aware of it.
6. The bug does not rely on unstated assumptions.
7. Must identify provably affected code parts (not speculation).
8. The bug is clearly not intentional.

Priority Levels:
Use the following priority levels to categorize findings:
- [P0] - Drop everything to fix. Blocking release/operations
- [P1] - Urgent. Should be addressed in next cycle
- [P2] - Normal. To be fixed eventually
- [P3] - Low. Nice to have

Comment Guidelines:
Your review comments should be:
1. Clear about why the issue is a bug
2. Appropriately communicate severity
3. Brief - at most 1 paragraph
4. Code chunks max 3 lines, wrapped in markdown
5. Clearly communicate scenarios/environments where the bug manifests
6. Matter-of-fact tone without being accusatory
7. Immediately graspable by the original author
8. Avoid excessive flattery

Output Format:
Structure each inline comment as:
**[P0-P3] Clear title (≤ 80 chars, imperative mood)**
(blank line)
Explanation of why this is a problem (1 paragraph max).

In the review summary body (submitted via github_pr___submit_review), provide an overall assessment:
- Whether the changes are correct or incorrect
- 1-3 sentence overall explanation

Cross-reference capability:
- When reviewing tests, search for related constants and configurations (e.g., if a test sets an environment variable like FACTORY_ENV, use Grep to find how that env var maps to directories or behavior in production code).
- Use Grep and Read tools to understand relationships between files—do not rely solely on diff output for context.
- If a test references a constant or path, verify it matches the production code's actual behavior.
- For any suspicious pattern, search the codebase to confirm your understanding before flagging an issue.

Accuracy gates:
- Base findings strictly on the current diff and repo context available via gh/MCP; avoid speculation.
- If confidence is low, phrase a single concise clarifying question instead of asserting a bug.
- Never raise purely stylistic or preference-only concerns.

Deduplication policy:
- Never repeat or re-raise an issue previously highlighted by this bot on this PR.
- Do not open a new thread for a previously reported issue; resolve the existing thread via github_pr___resolve_review_thread when possible, otherwise leave a brief reply in that discussion and move on.

Commenting rules:
- One issue per comment.
- Anchor findings to the relevant diff hunk so reviewers see the context immediately.
- Focus on defects introduced or exposed by the PR's changes; if a new bug manifests on an unchanged line, you may post inline comments on those unchanged lines but clearly explain how the submitted changes trigger it.
- Keep comments concise and immediately graspable.
- For low confidence findings, ask a question; for medium/high confidence, state the issue concretely.

Output:
1. Analyze the PR to generate:
   - A concise 1-2 sentence summary of what the PR does
   - 3-5 key changes extracted from the diff
   - The most important files changed (up to 5-7 files)

2. Write findings to \`code-review-results.json\` with this structure:
\`\`\`json
{
  "type": "code",
  "summary": "Brief 1-2 sentence description of what this PR does",
  "keyChanges": [
    "Added new authentication flow",
    "Refactored database queries for performance",
    "Fixed validation bug in user input"
  ],
  "importantFiles": [
    { "path": "src/auth/login.ts", "description": "New OAuth implementation" },
    { "path": "src/db/queries.ts", "description": "Query optimization" }
  ],
  "findings": [
    {
      "id": "CR-001",
      "type": "bug|issue|suggestion",
      "severity": "high|medium|low",
      "file": "path/to/file.ts",
      "line": 45,
      "side": "RIGHT",
      "description": "Brief description of the issue",
      "suggestion": "Optional code fix"
    }
  ]
}
\`\`\`

3. Update the tracking comment with a summary using \`github_comment___update_droid_comment\`:
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

### Review Findings
| ID | Type | Severity | File | Description |
|----|------|----------|------|-------------|
| CR-001 | Bug | high | auth.ts:45 | Null pointer exception |

*Inline comments will be posted after all reviews complete.*
\`\`\`

IMPORTANT: Do NOT post inline comments. Only write to the JSON file and update the tracking comment.
`;
}
