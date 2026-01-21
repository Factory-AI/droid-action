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

Generate **actionable** candidate inline comments.

This phase is optimized for recall: you MAY include candidates that are **likely-real** (not 100% proven), because Phase 2 (validator) will filter. However, every candidate MUST still include:

* A concrete trigger path (inputs/state that makes it happen)
* An observable bad outcome (exception type, wrong return, corrupted data, violated security property)
* The exact relevant symbols (function/class/variable names) so the validator can verify quickly

### Mandatory second-pass recall sweep (REQUIRED)

After completing your first pass, do a second sweep over **every changed file** specifically hunting for bugs in these high-yield categories:

* Optional/None dereferences (Optional types, nullable attributes, missing membership/context)
* Missing-key errors on external/untrusted dict/JSON payloads (KeyError, NoneType access)
* Wrong-variable / shadowing mistakes (e.g., using an outer variable instead of the scoped/local one)
* Type assumption bugs (e.g., numeric ops like math.floor/ceil on datetime/strings)
* Serializer/validated_data contract mismatches (field is named one thing but code reads another)
* Abstract base class contract issues (subclass missing required abstract members; runtime TypeError on instantiation)
* Concurrency/process lifecycle hazards (spawn process types, isinstance guards, join/terminate loops)
* Offset/cursor semantics mismatches (off-by-one, commit semantics, prev/next cursor behavior)
* OAuth/security invariants (e.g., OAuth state must be per-flow unpredictable; deterministic state is a vulnerability)

If you find a candidate during this sweep, it must still meet the Reporting Gate below, but do not stop early—complete the sweep across all files.

### Reporting Gate (same as review)

Do NOT over-focus on P1 crashes. Also include medium-severity correctness/contract issues when they have a concrete trigger and a clear wrong outcome.

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
