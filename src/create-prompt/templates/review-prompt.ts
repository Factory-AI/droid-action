import type { PreparedContext } from "../types";

export function generateReviewPrompt(
  context: PreparedContext,
): string {
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

Objectives:
1) Review the current PR diff and surface only clear, high-severity issues.
2) Output findings in JSON format for later processing (DO NOT post inline comments directly).
3) Update the tracking comment with a summary.

Procedure:
- Run: gh pr view ${prNumber} --repo ${repoFullName} --json comments,reviews
- Run: gh pr diff ${prNumber} --repo ${repoFullName}
- Run: gh api repos/${repoFullName}/pulls/${prNumber}/files --paginate --jq '.[] | {filename,patch,additions,deletions}'
- Analyze the diff for issues
- Write findings to \`code-review-results.json\` in the current directory

IMPORTANT: Do NOT post inline comments directly. Instead, write findings to a JSON file.
The finalize step will post all inline comments to avoid overlapping with security review comments.

Analysis scope (prioritize high-confidence findings):
- Correctness bugs and boundary errors
- Missing validation or contract misuse
- Concurrency or async hazards
- Evidence-based performance regressions (e.g., N+1 queries)
- Resource leaks or dead/unreachable code affecting behavior
- Regression risks relative to existing behavior or tests

Accuracy gates:
- Base findings strictly on the current diff and minimal repo context available via gh/MCP; avoid speculation.
- Prioritize high-severity/high-confidence issues; cap at 10 comments total.
- False positives are very undesirable—only surface an issue when you are genuinely confident.
- If confidence is low, phrase a single concise clarifying question instead of asserting a bug.
- Never raise purely stylistic or preference-only concerns.

Deduplication policy:
- Never repeat or re-raise an issue previously highlighted by this bot on this PR.
- Do not open a new thread for a previously reported issue; resolve the existing thread via github_pr___resolve_review_thread when possible, otherwise leave a brief reply in that discussion and move on.

Commenting rules:
- Maximum 10 inline comments total; one issue per comment.
- Anchor findings to the relevant diff hunk so reviewers see the context immediately.
- Focus on defects introduced or exposed by the PR's changes; if a new bug manifests on an unchanged line, you may post inline comments on those unchanged lines but clearly explain how the submitted changes trigger it.
- Tone should be deferential—write like a junior developer seeking confirmation; keep comments concise and respectful.
- For low confidence findings, ask a question; for medium/high confidence, state the issue concretely.

Output:
1. Write findings to \`code-review-results.json\` with this structure:
\`\`\`json
{
  "type": "code",
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
  ],
  "summary": "Brief overall summary"
}
\`\`\`

2. Update the tracking comment with a summary using \`github_comment___update_droid_comment\`:
\`\`\`markdown
## 📝 Code Review Summary

| Category | Count |
|----------|-------|
| 🐛 Bugs | X |
| ⚠️ Potential Issues | X |
| 💡 Suggestions | X |

### Findings
| ID | Type | File | Line | Description |
|----|------|------|------|-------------|
| CR-001 | Bug | auth.ts | 45 | Null pointer exception |

*Inline comments will be posted after all reviews complete.*
\`\`\`

IMPORTANT: Do NOT post inline comments. Only write to the JSON file and update the tracking comment.
`;
}
