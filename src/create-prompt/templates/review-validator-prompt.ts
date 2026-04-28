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

  const includeSuggestions = context.includeSuggestions !== false;

  const skillInstruction = includeSuggestions
    ? "Invoke the 'review' skill to load the review methodology, then execute its **Pass 2: Validation** procedure — including suggestion block rules."
    : "Invoke the 'review' skill to load the review methodology, then execute its **Pass 2: Validation** procedure. Do NOT include code suggestion blocks.";

  return `You are validating candidate review comments for PR #${prNumber} in ${repoFullName}.

IMPORTANT: This is Phase 2 (validator) of a two-pass review pipeline.

${skillInstruction}

### Context

* Repo: ${repoFullName}
* PR Number: ${prNumber}
* PR Head Ref: ${prHeadRef}
* PR Head SHA: ${prHeadSha}
* PR Base Ref: ${prBaseRef}

### Inputs

Read these files before validating:
* PR Description: \`${descriptionPath}\`
* Candidates: \`${reviewCandidatesPath}\`
* Full PR Diff: \`${diffPath}\`
* Existing Comments: \`${commentsPath}\`

If the diff is large, read in chunks (offset/limit). **Do not proceed until you have read the ENTIRE diff.**

### Critical Requirements

1. You MUST read and validate **every** candidate before posting anything.
2. Preserve ordering: keep results in the same order as candidates.
3. **Posting rule (STRICT):** Only post comments where \`status === "approved"\`. Never post rejected items.

### Language

Approved comments and the review summary must be in the language the PR author is using. Detect the language from the PR description and title at \`${descriptionPath}\`; fall back to English if uncertain. Do **not** mirror the language of the source files being reviewed (localized files, translations, \`docs/jp/...\`, etc.) — match the PR author's language. If a candidate was written in the wrong language (e.g., Japanese on an English PR because the diff touched JP docs), rewrite the body into the correct language while preserving meaning, the priority tag (\`[P0]\`/\`[P1]\`/\`[P2]\`/\`[P3]\`), and any \`[security]\` marker. Approve it if the underlying finding is otherwise valid; do not reject solely on language. Priority tags and the \`[security]\` marker remain in English regardless.

### Output: Write \`${reviewValidatedPath}\`

\`\`\`json
{
  "version": 1,
  "meta": {
    "repo": "${repoFullName}",
    "prNumber": ${prNumber},
    "headSha": "${prHeadSha}",
    "baseRef": "${prBaseRef}",
    "validatedAt": "<ISO timestamp>"
  },
  "results": [
    {
      "status": "approved",
      "comment": {
        "path": "src/index.ts",
        "body": "[P1] Title\\n\\n1 paragraph.",
        "line": 42,
        "startLine": null,
        "side": "RIGHT",
        "commit_id": "${prHeadSha}"
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
        "commit_id": "${prHeadSha}"
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

Notes:
* Use \`commit_id\` = \`${prHeadSha}\`.
* \`results\` MUST have exactly one entry per candidate, in the same order.

Tooling note:
* If the tools list includes \`ApplyPatch\` (common for OpenAI models like GPT-5.2), use \`ApplyPatch\` to create/update the file at the exact path.
* Otherwise, use \`Create\` (or \`Edit\` if overwriting) to write the file.

### Post approved items

After writing \`${reviewValidatedPath}\`, post comments ONLY for \`status === "approved"\`:

* Collect all approved comments and submit them as a **single batched review** via \`github_pr___submit_review\`, passing them in the \`comments\` array parameter.
* Do **NOT** post comments individually — batch them all into one \`submit_review\` call.
* Do **NOT** include a \`body\` parameter in \`submit_review\`.
* Use \`github_comment___update_droid_comment\` to update the tracking comment with the review summary.
* If any approved comments contain \`[security]\` in their body, prepend a security badge to the tracking comment: \`![Security Review](https://img.shields.io/badge/security%20review-ran-blue)\`. This indicates that security analysis was performed as part of the review.
* Do **NOT** post the summary as a separate comment or as the body of \`submit_review\`.
* Do not approve or request changes.
`;
}
