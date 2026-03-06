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
2. For each candidate, confirm:
   * It is a real, actionable bug (not speculative)
   * There is a realistic trigger path and observable wrong behavior
   * The anchor is valid (path + side + line/startLine correspond to the diff)
3. **Posting rule (STRICT):**
   * Only post comments where \`status === "approved"\`.
   * Never post rejected items.
4. Preserve ordering: keep results in the same order as candidates.

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

## Phase 2: Validate candidates

Apply the same Reporting Gate as review:

### Approve ONLY if at least one is true
* Definite runtime failure
* Incorrect logic with a concrete trigger path and wrong outcome
* Security vulnerability with realistic exploit
* Data corruption/loss
* Breaking contract change (discoverable in code/tests)

Reject if:
* It's speculative / "might" without a concrete trigger
* It's stylistic / naming / formatting
* It's not anchored to a valid changed line
* It's already reported (dedupe against existing comments)
* The anchor (path/side/line/startLine) would need to change to make the suggestion work — reject instead

### Deduplication (STRICT)

Before approving a candidate, check for duplicates:
1. **Among candidates**: If two or more candidates describe the same underlying bug (same root cause, even if anchored to different lines or worded differently), approve only the ONE with the best anchor and clearest explanation. Reject the rest with reason "duplicate of candidate N".
2. **Against existing comments**: If a candidate repeats an issue already covered by an existing PR comment (from \`${commentsPath}\`), reject it with reason "already reported in existing comments".
3. Same file + overlapping line range + same issue = duplicate, even if the body text differs.

Suggestion block rules (minimal):
* Preserve exact leading whitespace and keep blocks ≤ 100 lines
* Use RIGHT-side anchors only; do not include removed/LEFT-side lines
* For insert-only suggestions, repeat the anchor line unchanged, then append new lines
* Do not change the anchor fields (path/side/line/startLine) from the candidate — only edit the body

When rejecting, write a concise reason.

=======================

## Phase 3: Write review_validated.json (REQUIRED)

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

## Phase 4: Post approved items

After writing \`${reviewValidatedPath}\`, post comments ONLY for \`status === "approved"\`:

* Collect all approved comments and submit them as a **single batched review** via \`github_pr___submit_review\`, passing them in the \`comments\` array parameter.
* Do **NOT** post comments individually — batch them all into one \`submit_review\` call.
* do **NOT** include a \`body\` parameter in \`submit_review\`.
* Use \`github_comment___update_droid_comment\` to update the tracking comment with the review summary.
* Do **NOT** post the summary as a separate comment or as the body of \`submit_review\`.
* Do not approve or request changes.
`;
}
