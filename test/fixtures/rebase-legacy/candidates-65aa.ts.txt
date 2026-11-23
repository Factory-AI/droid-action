/**
 * Platform-agnostic Pass 1 (candidate generation) prompt.
 *
 * Both `src/create-prompt/templates/review-candidates-prompt.ts` (GitHub)
 * and `src/gitlab/prompts/candidates.ts` (GitLab) delegate to this builder
 * via thin adapters that supply a `ReviewTerminology` object plus the
 * runtime context (entity number, SHAs, artifact paths). The /review skill
 * itself is platform-agnostic; this builder produces the runtime harness
 * (where to read inputs, where to write the candidates JSON, what NOT to
 * call) around it.
 *
 * STRICT contract: this prompt MUST NOT instruct the model to call any
 * posting tool. Posting is Pass 2's responsibility, and tool gating is
 * additionally enforced at the `droid exec` level via `--enabled-tools`.
 */

import type { ReviewPromptContext } from "./types";

export function generateCandidatesPrompt(ctx: ReviewPromptContext): string {
  const {
    terminology: t,
    entityNumber,
    repoOrProject,
    headRef,
    headSha,
    baseRef,
    diffPath,
    commentsPath,
    descriptionPath,
    candidatesPath,
    includeSuggestions,
    securityReviewEnabled,
    sourceNote,
  } = ctx;

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

  const securitySubagentInstruction = securityReviewEnabled
    ? `

## Security Review (run concurrently)

In addition to the code review, you MUST also spawn a \`security-reviewer\` subagent via the Task tool.
This subagent runs **concurrently** with the code review subagents during Step 2.

Spawn it with:
- \`subagent_type\`: "security-reviewer"
- \`description\`: "Security review"
- \`prompt\`: Include the full ${t.entityNoun} context (${t.repoLabel.toLowerCase()}, ${t.entityNoun} ${t.metaEntityNumberKey === "prNumber" ? "number" : "IID"}, head SHA, ${t.baseRefShortLabel}) and the paths to precomputed data files (diff, description, existing comments). The security-reviewer will invoke the security-review skill and return a JSON array of security findings.

**IMPORTANT**: Spawn the security-reviewer in the SAME response as the code review subagents so they all run in parallel.

After all subagents complete (both code review and security-reviewer), merge the security findings into the \`comments\` array alongside code review findings. Security findings use the same schema but are prefixed with \`[security]\` in their body (e.g., \`[P1] [security] Title\`).
`
    : "";

  return `You are a senior staff software engineer and expert code reviewer.

Your task: Review ${t.entityNoun} ${t.entityNumberSigil}${entityNumber} in ${repoOrProject} and generate a JSON file with **high-confidence, actionable** review comments that pinpoint genuine issues.

${skillInstruction}${securitySubagentInstruction}

<context>
${t.repoLabel}: ${repoOrProject}
${t.entityNumberLabel}: ${entityNumber}
${t.headRefLabel}: ${headRef}
${t.headShaLabel}: ${headSha}
${t.baseRefLabel}: ${baseRef}

Precomputed data files:
- ${t.descriptionLabel}: \`${descriptionPath}\`
- ${t.diffLabel}: \`${diffPath}\`
- Existing Comments: \`${commentsPath}\`
</context>
${sourceNote ? `\n${sourceNote}\n` : ""}
<output_spec>
Write output to \`${candidatesPath}\` using this exact schema:

\`\`\`json
{
  "version": 1,
  "meta": {
    "${t.metaRepoKey}": "${t.repoExample}",
    "${t.metaEntityNumberKey}": 123,
    "headSha": "<head sha>",
    "${t.metaBaseRefKey}": "main",
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
  - \`${t.metaRepoKey}\`: "${repoOrProject}"
  - \`${t.metaEntityNumberKey}\`: ${entityNumber}
  - \`headSha\`: "${headSha}"
  - \`${t.metaBaseRefKey}\`: "${baseRef}"
  - \`generatedAt\`: ISO 8601 timestamp (e.g., "2024-01-15T10:30:00Z")

- **comments**: Array of comment objects
  - \`path\`: ${t.pathFieldDescription}
${bodyFieldDescription}
  - \`line\`: ${t.lineFieldDescription}
  - \`startLine\`: \`null\` for single-line comments, or start line number for multi-line comments
${sideFieldDescription}
  - \`commit_id\`: "${headSha}"

- **reviewSummary**:
  - \`body\`: 1-3 sentence overall assessment
</schema_details>
</output_spec>

<critical_constraints>
**DO NOT** post to ${t.platformName}.
**DO NOT** invoke any ${t.entityNoun} mutation tools ${t.mutationToolForbiddance}.
**DO NOT** modify any files other than writing to \`${candidatesPath}\`.
Output ONLY the JSON file—no additional commentary.
</critical_constraints>
`;
}
