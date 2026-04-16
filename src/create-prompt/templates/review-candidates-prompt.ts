import type { PreparedContext } from "../types";

export function generateReviewCandidatesPrompt(
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

  const includeSuggestions = context.includeSuggestions !== false;

  const bodyFieldDescription = includeSuggestions
    ? "  - `body`: Comment text starting with priority tag [P0|P1|P2], then title, then 1 paragraph explanation.\n" +
      "    Follow the suggestion block rules from the review skill when including suggestions."
    : "  - `body`: Comment text starting with priority tag [P0|P1|P2], then title, then 1 paragraph explanation";

  const sideFieldDescription = includeSuggestions
    ? '  - `side`: "RIGHT" for new/modified code (default). Use "LEFT" only for removed code **without** suggestions.\n' +
      "    If you include a suggestion block, choose a RIGHT-side anchor and keep it unchanged so the validator can reuse it."
    : '  - `side`: "RIGHT" for new/modified code (default), "LEFT" only for removed code';

  const skillInstruction = includeSuggestions
    ? "Invoke the 'review' skill to load the review methodology, then execute its **Pass 1: Candidate Generation** procedure — including suggestion block rules."
    : "Invoke the 'review' skill to load the review methodology, then execute its **Pass 1: Candidate Generation** procedure. Do NOT include code suggestion blocks.";

  const securityReviewEnabled = process.env.SECURITY_REVIEW_ENABLED === "true";

  const securitySubagentInstruction = securityReviewEnabled
    ? `

## Security Review (run concurrently)

In addition to the code review, you MUST also spawn a \`security-reviewer\` subagent via the Task tool.
This subagent runs **concurrently** with the code review subagents during Step 2.

Spawn it with:
- \`subagent_type\`: "security-reviewer"
- \`description\`: "Security review"
- \`prompt\`: Include the full PR context (repo, PR number, head SHA, base ref) and the paths to precomputed data files (diff, description, existing comments). The security-reviewer will invoke the security-review skill and return a JSON array of security findings.

**IMPORTANT**: Spawn the security-reviewer in the SAME response as the code review subagents so they all run in parallel.

After all subagents complete (both code review and security-reviewer), merge the security findings into the \`comments\` array alongside code review findings. Security findings use the same schema but are prefixed with \`[security]\` in their body (e.g., \`[P1] [security] Title\`).
`
    : "";

  return `You are a senior staff software engineer and expert code reviewer.

Your task: Review PR #${prNumber} in ${repoFullName} and generate a JSON file with **high-confidence, actionable** review comments that pinpoint genuine issues.

${skillInstruction}${securitySubagentInstruction}

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
      "body": "[P1] Title\\n\\n1 paragraph.",
      "line": 42,
      "startLine": null,
      "side": "RIGHT",
      "commit_id": "<head sha>"
    }
  ],
  "reviewSummary": {
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
  - \`generatedAt\`: ISO 8601 timestamp (e.g., "2024-01-15T10:30:00Z")

- **comments**: Array of comment objects
  - \`path\`: Relative file path (e.g., "src/index.ts")
${bodyFieldDescription}
  - \`line\`: Target line number (single-line) or end line number (multi-line). Must be ≥ 0.
  - \`startLine\`: \`null\` for single-line comments, or start line number for multi-line comments
${sideFieldDescription}
  - \`commit_id\`: "${prHeadSha}"

- **reviewSummary**:
  - \`body\`: 1-3 sentence overall assessment
</schema_details>
</output_spec>

<critical_constraints>
**DO NOT** post to GitHub.
**DO NOT** invoke any PR mutation tools (inline comments, submit review, delete/minimize/reply/resolve, etc.).
**DO NOT** modify any files other than writing to \`${reviewCandidatesPath}\`.
Output ONLY the JSON file—no additional commentary.
</critical_constraints>
`;
}
