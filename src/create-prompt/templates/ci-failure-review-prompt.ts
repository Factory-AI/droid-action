import type { PreparedContext } from "../types";

export type CIFailureContext = {
  checkRunName: string;
  checkRunConclusion: string;
  checkRunHtmlUrl: string;
  checkRunId: number;
  headSha: string;
};

export function generateCIFailureReviewPrompt(
  context: PreparedContext,
  ciContext: CIFailureContext,
): string {
  const prNumber = context.eventData.isPR
    ? context.eventData.prNumber
    : "unknown";

  const repoFullName = context.repository;
  const prHeadRef = context.prBranchData?.headRefName ?? "unknown";
  const prHeadSha = context.prBranchData?.headRefOid ?? ciContext.headSha;
  const prBaseRef = context.eventData.baseBranch ?? "unknown";

  const diffPath =
    context.reviewArtifacts?.diffPath ?? "$RUNNER_TEMP/droid-prompts/pr.diff";
  const commentsPath =
    context.reviewArtifacts?.commentsPath ??
    "$RUNNER_TEMP/droid-prompts/existing_comments.json";
  const descriptionPath =
    context.reviewArtifacts?.descriptionPath ??
    "$RUNNER_TEMP/droid-prompts/pr_description.txt";

  return `You are performing an automated code review for PR #${prNumber} in ${repoFullName}, triggered by a **CI failure**.

The gh CLI is installed and authenticated via GH_TOKEN.

### CI Failure Context

* **Failed check**: ${ciContext.checkRunName}
* **Conclusion**: ${ciContext.checkRunConclusion}
* **Check run URL**: ${ciContext.checkRunHtmlUrl}
* **Check run ID**: ${ciContext.checkRunId}
* **Head SHA**: ${ciContext.headSha}

### PR Context

* Repo: ${repoFullName}
* PR Number: ${prNumber}
* PR Head Ref: ${prHeadRef}
* PR Head SHA: ${prHeadSha}
* PR Base Ref: ${prBaseRef}
* The PR branch has already been checked out.

### Pre-computed Review Artifacts

* **PR Description**: \`${descriptionPath}\`
* **Full PR Diff**: \`${diffPath}\`
* **Existing Comments**: \`${commentsPath}\`

---

## Objective

Diagnose why CI failed on this PR and identify the code changes that caused the failure. Your goal is to help the PR author understand what broke and how to fix it.

---

## Procedure

### Phase 1: Gather CI Failure Details (REQUIRED)

1. Use \`get_ci_status\` with status "failure" to identify all failed workflow runs for this PR.
2. For each failed workflow run, use \`get_workflow_run_details\` to find the specific failed jobs and steps.
3. Use \`download_job_log\` to download the logs of failed jobs.
4. Read the downloaded log files to extract:
   - The exact error messages
   - The failing test names (if test failures)
   - The build error output (if build failures)
   - The linter/typecheck errors (if lint/type failures)

### Phase 2: Read PR Context

1. Read the PR description from \`${descriptionPath}\`
2. Read the full diff from \`${diffPath}\`
3. Read existing comments from \`${commentsPath}\`

### Phase 3: Correlate Failures with Code Changes

For each CI failure identified in Phase 1:

1. **Trace the error to source code**: Map each error message to specific files and lines in the diff.
2. **Verify the root cause**: Use Grep/Read to confirm the issue exists in the code. Do not speculate.
3. **Check if it's a pre-existing issue**: If the failure is in code not touched by this PR, note that explicitly.

### Phase 4: Report Findings

For each failure you can trace to the PR changes, post an inline comment using \`github_inline_comment___create_inline_comment\`:

**Comment format:**

\`\`\`
[CI-FAIL] <Clear title describing the failure>

<1 paragraph explaining what failed in CI, why this code caused it, and how to fix it.>

**CI Error:**
\`\`\`
<relevant snippet from CI logs>
\`\`\`
\`\`\`

Anchor rules:
* Use **path + side + line** anchoring
* RIGHT = new/modified code, LEFT = removed code
* Line numbers must correspond to the chosen side

### Phase 5: Submit Review Summary

Submit a review via \`github_pr___submit_review\` with:
* A summary of all CI failures found
* Which failures are caused by this PR vs pre-existing
* Suggested fixes for each failure
* Do NOT approve or request changes

### When CI failures are NOT caused by this PR

If after investigation you determine the CI failure is:
* A flaky test (passes sometimes, fails others)
* A pre-existing failure on the base branch
* An infrastructure issue (timeout, network error, runner issue)

Then post a single comment explaining this finding and do not post inline comments.

---

## Tools Available

You have access to CI-specific MCP tools:
* \`get_ci_status\` - Get CI status summary for this PR
* \`get_workflow_run_details\` - Get job and step details for a workflow run
* \`download_job_log\` - Download job logs to disk for analysis

Plus standard code analysis tools (Read, Grep, Glob, LS, Execute) and GitHub tools for posting comments.

---

## Priority Levels for CI Failures

* [P0] Build/compile failure — code cannot build
* [P1] Test failure — existing tests broken by PR changes
* [P1] Type error — typecheck failures introduced by PR
* [P2] Lint failure — linter errors introduced by PR
* [P3] Warning — new warnings introduced (only if CI is configured to fail on warnings)
`;
}
