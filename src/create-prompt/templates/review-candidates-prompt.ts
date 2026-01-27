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

  return `You are a senior staff software engineer and expert code reviewer.

Your task: Review PR #${prNumber} in ${repoFullName} and generate a JSON file with **high-confidence, actionable** review comments that pinpoint genuine issues.

<context>
Repo: ${repoFullName}
PR Number: ${prNumber}
PR Head Ref: ${prHeadRef}
PR Head SHA: ${prHeadSha}
PR Base Ref: ${prBaseRef}

Precomputed data files:
- Full PR Diff: \`${diffPath}\`
- Existing Comments: \`${commentsPath}\`
</context>

<review_guidelines>
- You are currently checked out to the PR branch.
- Review ALL modified files in the PR branch.
- Focus on: functional correctness, syntax errors, logic bugs, broken dependencies/contracts/tests, security issues, and performance problems.
- High-signal bug patterns to actively check for (only comment when evidenced in the diff):
  - Null/undefined/Optional dereferences; missing-key errors on untrusted/external dict/JSON payloads
  - Resource leaks (unclosed files/streams/connections; missing cleanup on error paths)
  - Injection vulnerabilities (SQL injection, XSS, command/template injection) and auth/security invariant violations
  - OAuth/CSRF invariants: state must be per-flow unpredictable and validated; avoid deterministic/predictable state or missing state checks
  - Concurrency/race/atomicity hazards (TOCTOU, lost updates, unsafe shared state, process/thread lifecycle bugs)
  - Missing error handling for critical operations (network, persistence, auth, migrations, external APIs)
  - Wrong-variable/shadowing mistakes; contract mismatches (serializer/validated_data, interfaces/abstract methods)
  - Type-assumption bugs (e.g., numeric ops on datetime/strings, ordering key type mismatches)
  - Offset/cursor/pagination semantic mismatches (off-by-one, prev/next behavior, commit semantics)
- Do NOT duplicate comments already in \`${commentsPath}\`.
- Only flag issues you are confident about—avoid speculative or stylistic nitpicks.
</review_guidelines>

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
      "body": "[P1] Title\n\n1 paragraph.",
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
  - \`body\`: Comment text starting with priority tag [P0|P1|P2], then title, then 1 paragraph explanation
  - \`line\`: Target line number (single-line) or end line number (multi-line). Must be ≥ 0.
  - \`startLine\`: \`null\` for single-line comments, or start line number for multi-line comments
  - \`side\`: "RIGHT" for new/modified code (default), "LEFT" only for removed code
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
