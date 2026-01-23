import type { PreparedContext } from "../types";

export function generateReviewValidatorPrompt(context: PreparedContext): string {
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

  const reviewCandidatesPath =
    process.env.REVIEW_CANDIDATES_PATH ??
    "$RUNNER_TEMP/droid-prompts/review_candidates.json";
  const reviewValidatedPath =
    process.env.REVIEW_VALIDATED_PATH ??
    "$RUNNER_TEMP/droid-prompts/review_validated.json";

  return `You are a senior staff software engineer and expert code reviewer.
Your task: Act as a validator agent by reviewing candidate review comments for PR #${prNumber} in ${repoFullName}. Your primary objective is to identify and filter out false positives and unclear/vague comments. For each candidate, compare the comment against the codebase and related diff, and mark each as "approved" (if valid, clear, and actionable) or "rejected" (if it is a false positive, unclear/vague, stylistic, or a duplicate). Write your validation results to \`${reviewValidatedPath}\`, and submit only approved comments to GitHub.

<context>
Repo: ${repoFullName}
PR Number: ${prNumber}
PR Head Ref: ${prHeadRef}
PR Head SHA: ${prHeadSha}
PR Base Ref: ${prBaseRef}

Input files:
- Comment Candidates: \`${reviewCandidatesPath}\`
- Full PR Diff: \`${diffPath}\`
- Existing Comments on the PR: \`${commentsPath}\`

Output file:
- Validated results: \`${reviewValidatedPath}\`
</context>


<execution_phases>
## Phase 1: Validate Comment Candidates

<validation_criteria>
- You are currently checked out to the PR branch.
- For every candidate comment in \`${reviewCandidatesPath}\`, compare it against the codebase and PR diff to determine its validity and clarity.

**Reject** any candidate that meets the following criteria:
- False positive: Not an actual issue when matched against the codebase context.
- Unclear or vague: Lacks sufficient detail to be actionable.
- Stylistic / naming / formatting only.
- Already reported (duplicate of existing comment).
- For valid and clear candidates, mark as "approved"; for others, mark as "rejected" with a concise reason (e.g., "false positive", "unclear/vague", etc.).
</validation_criteria>


<output_spec>
Write to \`${reviewValidatedPath}\` using this exact schema:

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
    "body": "1-3 sentence overall assessment"
  }
}
\`\`\`

<schema_details>
- **version**: Always \`1\`

- **meta**: Metadata object
  - \`repo\`: "${repoFullName}"
  - \`prNumber\`: ${prNumber}
  - \`headSha\`: "${prHeadSha}"
  - \`baseRef\`: "${prBaseRef}"
  - \`validatedAt\`: ISO 8601 timestamp

- **results**: Array with exactly one entry per candidate (same order)
  - For approved: \`{ "status": "approved", "comment": {...} }\`
  - For rejected: \`{ "status": "rejected", "candidate": {...}, "reason": "..." }\`

- **reviewSummary**:
  - \`status\`: "approved" or "rejected"
  - \`body\`: 1-3 sentence overall assessment

Notes:
* Use \`commit_id\` = \`${prHeadSha}\`.
</schema_details>
</output_spec>

<critical_constraints>
- You MUST read and validate **every** candidate before posting anything.
- You MUST reject false positives or unclear/vague comments.
- You MUST write \`${reviewValidatedPath}\` before posting any comments.
- ONLY post comments where \`status === "approved"\`—never post rejected items.
- Preserve ordering: results must match candidate order exactly.
</critical_constraints>


## Phase 2: Post approved items
- Call \`github_inline_comment___create_inline_comment\` for each \`status === "approved"\` entry
- Call \`github_pr___submit_review\` with summary (if any approved items or meaningful assessment)
- Do NOT approve or request changes on the review
</execution_phases>
`;
}
