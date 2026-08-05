/**
 * Platform-agnostic Pass 2 (validator) prompt.
 *
 * The validator reads the candidates JSON produced by Pass 1, validates
 * each one, and writes a refined JSON to disk. What happens next depends
 * on `postingMode`:
 *
 *   - "tool" (GitHub): the agent posts the approved findings itself as a
 *     single batched call to the platform's submit-review MCP tool. Pass 2
 *     is the only place that tool is exposed (via `--enabled-tools`).
 *   - "file" (GitLab): the validated JSON *is* the deliverable, and a CI
 *     step posts it through the platform API. The agent holds no
 *     MR-mutation tools at all.
 *
 * Both `src/create-prompt/templates/review-validator-prompt.ts` (GitHub)
 * and `src/gitlab/prompts/validator.ts` (GitLab) delegate to this builder
 * via thin adapters that supply a `ReviewTerminology` shape.
 */

import type { ReviewPromptContext, ReviewTerminology } from "./types";

function requireToolField(
  value: string | undefined,
  field: keyof ReviewTerminology,
): string {
  if (value === undefined) {
    throw new Error(
      `validator prompt with postingMode "tool" requires terminology.${field}`,
    );
  }
  return value;
}

function buildToolPostingSection(
  t: ReviewTerminology,
  validatedPath: string,
): string {
  const submitReviewToolName = requireToolField(
    t.submitReviewToolName,
    "submitReviewToolName",
  );
  const updateTrackingToolName = requireToolField(
    t.updateTrackingToolName,
    "updateTrackingToolName",
  );
  return `### Post approved items

After writing \`${validatedPath}\`, post comments ONLY for \`status === "approved"\`:

* Collect all approved comments and submit them as a **single batched review** via \`${submitReviewToolName}\`, passing them in the \`comments\` array parameter${t.submitReviewExtraArg ?? ""}.
* Do **NOT** post comments individually — batch them all into one \`submit_review\` call.
* Do **NOT** include a \`body\` parameter in \`submit_review\`${t.submitReviewBodyExclusionTrailer ?? ""}.
* Use \`${updateTrackingToolName}\` to update the ${t.trackingCommentName ?? "tracking comment"} with the review summary.
* Do **NOT** post the summary as a separate ${t.summaryEntityName ?? "comment"}${t.summaryPostingExtraExclusion ?? ""}.
* ${t.approvalChangesNote ?? ""}
`;
}

function buildFilePostingSection(
  t: ReviewTerminology,
  validatedPath: string,
): string {
  return `### Do not post anything yourself

Writing \`${validatedPath}\` is your final action. A separate CI step reads
that file and posts every \`status === "approved"\` comment to the ${t.entityNoun}
through the ${t.platformName} API, then updates the ${t.trackingCommentName ?? "tracking comment"} with your
\`reviewSummary.body\`.

* Do **NOT** attempt to post, comment on, or otherwise mutate the ${t.entityNoun} — not via
  MCP tools, not via \`curl\`/\`glab\`/\`git\` through \`Execute\`, not by any other route.
* Do **NOT** write a summary anywhere other than the \`reviewSummary\` field of
  \`${validatedPath}\`.
* Anything you leave out of \`${validatedPath}\`, or mark as anything other than
  \`"approved"\`, will never reach the ${t.entityNoun}. That file is the whole contract.
* An approved comment without a usable line anchor cannot be posted, so make sure
  every approved comment keeps its \`path\` and \`line\`.
`;
}

export function generateValidatorPrompt(ctx: ReviewPromptContext): string {
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
    validatedPath,
    includeSuggestions,
    postingMode = "tool",
  } = ctx;

  if (!validatedPath) {
    throw new Error("validator prompt requires validatedPath in context");
  }

  const skillInstruction = includeSuggestions
    ? "Invoke the 'review' skill to load the review methodology, then execute its **Pass 2: Validation** procedure — including suggestion block rules."
    : "Invoke the 'review' skill to load the review methodology, then execute its **Pass 2: Validation** procedure. Do NOT include code suggestion blocks.";

  const postingSection =
    postingMode === "file"
      ? buildFilePostingSection(t, validatedPath)
      : buildToolPostingSection(t, validatedPath);

  return `You are validating candidate review comments for ${t.entityNoun} ${t.entityNumberSigil}${entityNumber} in ${repoOrProject}.

IMPORTANT: This is Phase 2 (validator) of a two-pass review pipeline.

${skillInstruction}

### Context

* ${t.repoLabel}: ${repoOrProject}
* ${t.entityNumberLabel}: ${entityNumber}
* ${t.headRefLabel}: ${headRef}
* ${t.headShaLabel}: ${headSha}
* ${t.baseRefLabel}: ${baseRef}

### Inputs

Read these files before validating:
* ${t.descriptionLabel}: \`${descriptionPath}\`
* Candidates: \`${candidatesPath}\`
* ${t.diffLabel}: \`${diffPath}\`
* Existing Comments: \`${commentsPath}\`

If the diff is large, read in chunks (offset/limit). **Do not proceed until you have read the ENTIRE diff.**

### Critical Requirements

1. You MUST read and validate **every** candidate before ${postingMode === "file" ? `writing \`${validatedPath}\`` : "posting anything"}.
2. Preserve ordering: keep results in the same order as candidates.
3. ${
    postingMode === "file"
      ? `**Approval rule (STRICT):** mark a candidate \`"approved"\` only if you would stand behind posting it as-is — approved entries are posted verbatim. Everything else must be \`"rejected"\`.`
      : `**Posting rule (STRICT):** Only post comments where \`status === "approved"\`. Never post rejected items.`
  }

### Output: Write \`${validatedPath}\`

\`\`\`json
{
  "version": 1,
  "meta": {
    "${t.metaRepoKey}": "${repoOrProject}",
    "${t.metaEntityNumberKey}": ${entityNumber},
    "headSha": "${headSha}",
    "${t.metaBaseRefKey}": "${baseRef}",
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
        "commit_id": "${headSha}"
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
        "commit_id": "${headSha}"
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
* Use \`commit_id\` = \`${headSha}\`.
* \`results\` MUST have exactly one entry per candidate, in the same order.

Tooling note:
* If the tools list includes \`ApplyPatch\` (common for OpenAI models like GPT-5.2), use \`ApplyPatch\` to create/update the file at the exact path.
* Otherwise, use \`Create\` (or \`Edit\` if overwriting) to write the file.

${postingSection}`;
}
