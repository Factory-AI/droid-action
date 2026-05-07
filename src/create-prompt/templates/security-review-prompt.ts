import type { PreparedContext } from "../types";

export function generateSecurityCandidatesPrompt(
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

  return `You are a senior security engineer performing a security-focused code review.

Your task: Review PR #${prNumber} in ${repoFullName} and generate a JSON file with **high-confidence security vulnerability** findings.

Invoke the 'security-review' skill to load the security review methodology, then execute its **Pass 1: Candidate Generation** procedure.

<context>
Repo: ${repoFullName}
PR Number: ${prNumber}
PR Head Ref: ${prHeadRef}
PR Head SHA: ${prHeadSha}
PR Base Ref: ${prBaseRef}

Precomputed data files:
- PR Description: \`${descriptionPath}\`
- Full PR Diff: \`${diffPath}\`
- Existing Comments: \`${commentsPath}\`
</context>

<output_spec>
Write output to \`${reviewCandidatesPath}\` using this exact schema:

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
      "body": "[P1] [security] Title\\n\\n1 paragraph.",
      "line": 42,
      "startLine": null,
      "side": "RIGHT",
      "commit_id": "<head sha>"
    }
  ],
  "reviewSummary": {
    "body": "1-3 sentence security assessment"
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
  - \`generatedAt\`: ISO 8601 timestamp

- **comments**: Array of comment objects
  - \`path\`: Relative file path
  - \`body\`: Comment text starting with priority tag [P0|P1|P2|P3] and \`[security]\` tag, then title, then 1 paragraph explanation
  - \`line\`: Target line number (single-line) or end line number (multi-line). Must be >= 0.
  - \`startLine\`: \`null\` for single-line comments, or start line number for multi-line comments
  - \`side\`: "RIGHT" for new/modified code (default), "LEFT" only for removed code
  - \`commit_id\`: "${prHeadSha}"

- **reviewSummary**:
  - \`body\`: 1-3 sentence security assessment
</schema_details>
</output_spec>

<language>
Write every finding — titles, explanations, suggestion prose, and the \`reviewSummary.body\` — in the language the PR author is using. Detect the language from the PR description and title at \`${descriptionPath}\`; fall back to English if uncertain. Do **not** mirror the language of the source files being reviewed: when the diff includes localized files (translations, \`docs/jp/...\`, \`docs/ko/...\`, \`.es.mdx\`, etc.), still write findings in the PR author's language, not the file's. Priority tags (\`[P0]\`/\`[P1]\`/\`[P2]\`/\`[P3]\`) and the \`[security]\` marker remain in English regardless.
</language>

<critical_constraints>
**DO NOT** post to GitHub.
**DO NOT** invoke any PR mutation tools (inline comments, submit review, delete/minimize/reply/resolve, etc.).
**DO NOT** modify any files other than writing to \`${reviewCandidatesPath}\`.
Output ONLY the JSON file — no additional commentary.
</critical_constraints>
`;
}
