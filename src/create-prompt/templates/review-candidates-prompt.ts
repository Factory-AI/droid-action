import type { PreparedContext } from "../types";

export function generateReviewCandidatesPrompt(context: PreparedContext): string {
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

  return `You are generating **candidate** inline review comments for PR #${prNumber} in ${repoFullName}.

IMPORTANT: This is Phase 1 of a two-pass review pipeline.

### Context

* Repo: ${repoFullName}
* PR Number: ${prNumber}
* PR Head Ref: ${prHeadRef}
* PR Head SHA: ${prHeadSha}
* PR Base Ref: ${prBaseRef}

### Pre-computed Review Artifacts

The following files have been pre-computed and contain the COMPLETE data for this PR:

* **Full PR Diff**: \`${diffPath}\`
* **Existing Comments**: \`${commentsPath}\`

### Output

Write your candidates to: \`${reviewCandidatesPath}\`

You must write a single JSON object with the schema below.

### CRITICAL RULES

* **DO NOT** post to GitHub in this run.
* **DO NOT** call any PR mutation tools (inline comments, submit review, delete/minimize/reply/resolve, etc.).
* You MAY update the tracking comment for progress.

=======================

## Phase 1: Context Gathering (REQUIRED — do not output yet)

1. Read existing comments:
   Read \`${commentsPath}\`

2. Read the COMPLETE diff:
   Read \`${diffPath}\`
   If large, read in chunks (offset/limit). **Do not proceed until you have read the ENTIRE diff.**

3. List every changed file (your checklist) and review ALL of them.

=======================

## Phase 2: Candidate Generation

Generate **high-confidence, actionable** candidate inline comments following the same standards as the single-pass review:

### Reporting Gate (same as review)

Only include candidates that meet at least one:
* Definite runtime failure
* Incorrect logic with a concrete trigger path and wrong outcome
* Security vulnerability with realistic exploit
* Data corruption/loss
* Breaking contract change (discoverable in code/tests)

Do NOT include:
* Style/naming/formatting
* "What-if" speculation without a realistic execution path
* Vague suggestions to add guards/try-catch without a concrete failure

### Deduplication

Use \`${commentsPath}\` to avoid duplicating issues already reported by this bot.
If an issue appears fixed, do NOT create a new candidate; the validator run will handle replies.

=======================

## Phase 3: Write candidates JSON (REQUIRED)

Write \`${reviewCandidatesPath}\` with this schema:

\`\`\`json
{
  "version": 1,
  "meta": {
    "repo": "owner/repo",
    "prNumber": 123,
    "headSha": "<head sha>",
    "baseRef": "main",
    "generatedAt": "<ISO timestamp>"
  },
  "comments": [
    {
      "path": "src/index.ts",
      "body": "[P1] Title\n\n1 paragraph.",
      "line": 42,
      "startLine": null,
      "side": "RIGHT",
      "commit_id": "<head sha>"
    }
  ],
  "reviewSummary": {
    "body": "1–3 sentence overall assessment"
  }
}
\`\`\`

Notes:
* \`comments[]\` entries MUST match the input shape of \`github_inline_comment___create_inline_comment\`.
* Use \`commit_id\` = \`${prHeadSha}\`.
* \`startLine\` should be \`null\` unless you are making a multi-line comment.

Then write the file using the local file tool.

Tooling note:
* If the tools list includes \`ApplyPatch\` (common for OpenAI models like GPT-5.2), use \`ApplyPatch\` to create/update the file at the exact path.
* Otherwise, use \`Create\` (or \`Edit\` if overwriting) to write the file.
`;
}
