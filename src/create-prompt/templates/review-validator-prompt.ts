import { formatGuidelinesSection } from "../../utils/review-guidelines";
import type { PreparedContext } from "../types";

export function generateReviewValidatorPrompt(
  context: PreparedContext,
): string {
  const prNumber = context.eventData.isPR
    ? context.eventData.prNumber
    : context.githubContext && "entityNumber" in context.githubContext
      ? String(context.githubContext.entityNumber)
      : "unknown";

  const repoFullName = context.repository;
  const prHeadRef = context.prBranchData?.headRefName ?? "unknown";
  const prHeadSha = context.prBranchData?.headRefOid ?? "unknown";
  const prBaseRef = context.eventData.baseBranch ?? "unknown";

  const diffPath =
    context.reviewArtifacts?.diffPath ?? "$RUNNER_TEMP/droid-prompts/pr.diff";
  const commentsPath =
    context.reviewArtifacts?.commentsPath ??
    "$RUNNER_TEMP/droid-prompts/existing_comments.json";
  const descriptionPath =
    context.reviewArtifacts?.descriptionPath ??
    "$RUNNER_TEMP/droid-prompts/pr_description.txt";

  const reviewCandidatesPath =
    process.env.REVIEW_CANDIDATES_PATH ??
    "$RUNNER_TEMP/droid-prompts/review_candidates.json";
  const reviewValidatedPath =
    process.env.REVIEW_VALIDATED_PATH ??
    "$RUNNER_TEMP/droid-prompts/review_validated.json";

  return `You are validating candidate review comments for PR #${prNumber} in ${repoFullName}.

IMPORTANT: This is Phase 2 (validator) of a two-pass review pipeline.
${formatGuidelinesSection(context.reviewGuidelines)}
### Context

* Repo: ${repoFullName}
* PR Number: ${prNumber}
* PR Head Ref: ${prHeadRef}
* PR Head SHA: ${prHeadSha}
* PR Base Ref: ${prBaseRef}

### Inputs

Read:
* PR Description: \`${descriptionPath}\`
* Candidates: \`${reviewCandidatesPath}\`
* Full PR Diff: \`${diffPath}\`
* Existing Comments: \`${commentsPath}\`

### Outputs

1) Write validated results to: \`${reviewValidatedPath}\`
2) Post ONLY the approved inline comments to the PR
3) Submit a PR review summary (if applicable)

=======================

## CRITICAL REQUIREMENTS

1. You MUST read and validate **every** candidate before posting anything.
2. For each candidate, **verify by reading the actual source code** that:
   * The bug is real and reproducible — you can trace a specific input/call sequence through the code that hits the buggy path
   * The claimed behavior is actually wrong (not just unconventional or suboptimal)
   * The anchor is valid (path + side + line/startLine correspond to the diff)
3. **Posting rule (STRICT):**
   * Only post comments where \`status === "approved"\`.
   * Never post rejected items.
4. Preserve ordering: keep results in the same order as candidates.
5. **When in doubt, reject.** A false positive is worse than a missed bug. Only approve findings you are highly confident about after reading the code.

=======================

## Phase 1: Load context (REQUIRED)

1. Read the PR description:
   Read \`${descriptionPath}\`

2. Read existing comments:
   Read \`${commentsPath}\`

3. Read the COMPLETE diff:
   Read \`${diffPath}\`
   If large, read in chunks (offset/limit). **Do not proceed until you have read the ENTIRE diff.**

4. Read candidates:
   Read \`${reviewCandidatesPath}\`

=======================

## Phase 2: Validate candidates (approve/reject ONLY — no suggestions yet)

**IMPORTANT**: In this phase you are ONLY deciding approve or reject. Do NOT think about fixes or suggestions yet. That comes later in Phase 3.

For each candidate, read the relevant source files and verify the claim.

### Approve ONLY if ALL of these are true
1. The issue falls into one of these categories:
   * Definite runtime failure (crash, exception, panic)
   * Incorrect logic where you can name a specific input that produces wrong output
   * Security vulnerability with a concrete exploit path
   * Data corruption or silent data loss
   * Breaking contract change (verified by reading the interface/callers)
2. You verified the claim by reading the actual source code (not just the diff)
3. The bug is in **production code that ships to users**, not merely a test-quality concern

### Reject if ANY of these are true
* It's speculative — uses "might", "could", "potentially" without naming a concrete trigger
* It's about test quality, test flakiness, or test coverage (unless the test change masks a real production bug)
* It's stylistic, naming, formatting, or "best practice" without a concrete failure
* It's not anchored to a valid changed line in the diff
* It's already reported (dedupe against existing comments)
* The candidate describes a pre-existing issue not introduced or worsened by this PR
* You cannot verify the claim after reading the relevant source files

### Deduplication (STRICT)

Before approving a candidate, check for duplicates:
1. **Among candidates**: If two or more candidates describe the same underlying bug (same root cause, even if anchored to different lines or worded differently), approve only the ONE with the best anchor and clearest explanation. Reject the rest with reason "duplicate of candidate N".
2. **Against existing comments**: If a candidate repeats an issue already covered by an existing PR comment (from \`${commentsPath}\`), reject it with reason "already reported in existing comments".
3. Same file + overlapping line range + same issue = duplicate, even if the body text differs.

When rejecting, write a concise reason.

**Complete ALL approve/reject decisions before proceeding to Phase 3.**

=======================

## Phase 3: Add suggestions to approved items (ONLY after all decisions are final)

Now go back through ONLY the approved items and consider adding a suggestion block.
Your approve/reject decisions from Phase 2 are final — do NOT change them here.

**Add a suggestion ONLY when ALL of these are true:**
* The fix is obvious and unambiguous (a single clear correct change)
* The fix is scoped to the reported line range (no cascading changes needed)
* You are confident the fix will not break CI or other code paths
* The anchor (path/side/line/startLine) does not need to change to make the suggestion work

**Do NOT add a suggestion when:**
* The fix requires changes in multiple locations
* There are multiple valid ways to fix the issue
* The fix requires understanding broader context not visible in the diff
* The candidate already explains the issue clearly enough for the author to fix it

When adding a suggestion, append it to the comment body:

\`\`\`suggestion
<replacement code>
\`\`\`

Rules:
* Keep blocks ≤ 100 lines
* Preserve exact leading whitespace of replaced lines
* Use RIGHT-side anchors only; do not include removed/LEFT-side lines
* For insert-only suggestions, repeat the anchor line unchanged, then append new lines

=======================

## Phase 4: Write review_validated.json (REQUIRED)

Write \`${reviewValidatedPath}\` with this schema:

\`\`\`json
{
  "version": 1,
  "meta": {
    "repo": "owner/repo",
    "prNumber": 123,
    "headSha": "<head sha>",
    "baseRef": "main",
    "validatedAt": "<ISO timestamp>"
  },
  "results": [
    {
      "status": "approved",
      "comment": {
        "path": "src/index.ts",
        "body": "[P1] Title\n\n1 paragraph.",
        "line": 42,
        "startLine": null,
        "side": "RIGHT",
        "commit_id": "<head sha>"
      }
    },
    {
      "status": "rejected",
      "candidate": {
        "path": "src/other.ts",
        "body": "[P2] ...",
        "line": 10,
        "startLine": null,
        "side": "RIGHT",
        "commit_id": "<head sha>"
      },
      "reason": "Not a real bug because ..."
    }
  ],
  "reviewSummary": {
    "status": "approved",
    "body": "1–3 sentence overall assessment"
  }
}
\`\`\`

Notes:
* Use \`commit_id\` = \`${prHeadSha}\`.
* \`results\` MUST have exactly one entry per candidate, in the same order.

Then write the file using the local file tool.

Tooling note:
* If the tools list includes \`ApplyPatch\` (common for OpenAI models like GPT-5.2), use \`ApplyPatch\` to create/update the file at the exact path.
* Otherwise, use \`Create\` (or \`Edit\` if overwriting) to write the file.

=======================

## Phase 5: Post approved items

After writing \`${reviewValidatedPath}\`, post comments ONLY for \`status === "approved"\`:

* For each approved entry, call \`github_inline_comment___create_inline_comment\` with the \`comment\` object.
* Submit a review via \`github_pr___submit_review\` using the summary body (if there are any approved items OR a meaningful overall assessment).
* Do not approve or request changes.
`;
}
