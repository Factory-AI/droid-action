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
1) Re-check existing review comments; if a previously reported issue appears fixed, leave a brief "resolved" reply (do NOT programmatically resolve threads).
2) Review the PR diff and surface all bugs that meet the detection criteria below.
3) Leave concise inline comments (1-2 sentences) on bugs introduced by the PR. You may also comment on unchanged lines if the PR's changes expose or trigger issues there—but explain the connection clearly.

Procedure:
Follow these phases IN ORDER. Do not skip to submitting findings until you complete Phase 1.

## Phase 1: Context Gathering (REQUIRED before making any findings)
1. Check existing comments: gh pr view ${prNumber} --repo ${repoFullName} --json comments,reviews
2. Get the full diff:
   - git fetch origin ${baseRefName}:refs/remotes/origin/${baseRefName}
   - MERGE_BASE=$(git merge-base HEAD refs/remotes/origin/${baseRefName})
   - git diff $MERGE_BASE..HEAD
3. For EACH file in the diff, gather context:
   - For new imports: Grep to verify the imported symbol exists
   - For new/modified functions: Grep for callers to understand usage patterns
   - For functions that process data: Read surrounding code to understand expected types
4. Do NOT identify bugs yet - focus only on understanding the changes.

## Phase 2: Issue Identification (ONLY AFTER Phase 1 is complete)
1. Review ALL changed lines systematically - Do NOT stop after finding just a few issues
2. For each potential issue:
   - Verify with Grep/Read before flagging (do not speculate)
   - Trace data flow to confirm the bug path exists
   - Check if the pattern exists elsewhere in the codebase (may be intentional)
3. Continue until you have reviewed every changed line in every file
4. Cross-reference checks:
   - When reviewing tests, search for related constants and configurations
   - Use Grep and Read tools to understand relationships between files—do not rely solely on diff output
   - If a test references a constant or path, verify it matches the production code's actual behavior
5. Import verification:
   - For new imports, use Grep to verify the imported symbol actually exists in the codebase or is a valid external package
   - Flag any import that references a non-existent symbol as a bug (will cause ImportError/ModuleNotFoundError at runtime)
6. Accuracy gates:
   - Only flag bugs introduced by this PR (not pre-existing issues)
   - Base findings strictly on the current diff and repo context; avoid speculation
   - If confidence is low, phrase a clarifying question instead of asserting a bug
   - Never raise purely stylistic or preference-only concerns
7. Deduplication: Never repeat or re-raise an issue previously highlighted by this bot on this PR
8. Priority levels for findings:
   - [P0] - Drop everything to fix. Blocking release/operations
   - [P1] - Urgent. Should be addressed in next cycle
   - [P2] - Normal. To be fixed eventually
   - [P3] - Low. Nice to have
9. Comment format for each finding:
   - Structure: **[P0-P3] Clear title (≤ 80 chars, imperative mood)** followed by 1 paragraph explanation
   - Be clear about why it's a bug and when/where it manifests
   - Brief (1 paragraph max), code chunks max 3 lines
   - Matter-of-fact tone, immediately graspable by the author
10. Thorough analysis checklist (complete before moving to Phase 3):
   - Do NOT submit after finding only 2-3 issues - a common failure mode is stopping too early
   - Have you examined every modified function/method in each changed file?
   - If the PR touches multiple files, have you analyzed interactions between changes?
   - When you found a bug pattern, did you search for the same pattern elsewhere in the diff?
   - For PRs >200 lines: explicitly confirm all sections have been reviewed

## Phase 3: Submit Review
- Prefer github_inline_comment___create_inline_comment with side="RIGHT" to post inline findings on changed/added lines
- Compute exact diff positions (path + position) for each issue; every substantive comment must be inline on the changed line (no new top-level issue comments).
- Detect prior top-level "no issues" comments authored by this bot (e.g., "no issues", "No issues found", "LGTM", including emoji-prefixed variants).
- If the current run finds issues and prior "no issues" comments exist, delete them via gh api -X DELETE repos/${repoFullName}/issues/comments/<comment_id>; if deletion fails, minimize via GraphQL or reply "Superseded: issues were found in newer commits".
- IMPORTANT: Do NOT delete comment ID ${context.droidCommentId} - this is the tracking comment for the current run.
Preferred MCP tools (when available):
- github_inline_comment___create_inline_comment to post inline feedback anchored to the diff
- github_pr___submit_review to send inline review feedback
- github_pr___delete_comment to remove outdated "no issues" comments
- github_pr___minimize_comment when deletion is unavailable but minimization is acceptable
- github_pr___reply_to_comment to reply to existing threads (e.g., acknowledge fixed issues)

Diff Side Selection (CRITICAL):  
- When calling github_inline_comment___create_inline_comment, ALWAYS specify the 'side' parameter  
- Use side="RIGHT" for comments on NEW or MODIFIED code (what the PR adds/changes)  
- Use side="LEFT" ONLY when commenting on code being REMOVED (only if you need to reference the old implementation)  
- The 'line' parameter refers to the line number on the specified side of the diff  
- Ensure the line numbers you use correspond to the side you choose;

Submission:
- Do not submit inline comments when:
  - the PR appears formatting-only, or
  - you cannot anchor a high-confidence issue to a specific changed line.
- Submit all findings P0-P3 that meet the bug detection criteria. Low-severity issues (P2/P3) should still be submitted if they would cause runtime errors, incorrect behavior, or security vulnerabilities.
- Do not escalate style/formatting into P0/P1 just to justify leaving an inline comment.
- If no issues are found and a prior "no issues" comment from this bot already exists, skip submitting another comment to avoid redundancy.
- If no issues are found and no prior "no issues" comment exists, post a single brief top-level summary noting no issues.
- If issues are found, delete/minimize/supersede any prior "no issues" comment before submitting.
- Prefer github_inline_comment___create_inline_comment for inline findings and submit the overall review via github_pr___submit_review (fall back to gh api repos/${repoFullName}/pulls/${prNumber}/reviews -f event=COMMENT -f body="$SUMMARY" -f comments='[$COMMENTS_JSON]' when MCP tools are unavailable).
- Do not approve or request changes; submit a comment-only review with inline feedback.
`;
}
