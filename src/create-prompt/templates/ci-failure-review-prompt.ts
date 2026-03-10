import { generateReviewCandidatesPrompt } from "./review-candidates-prompt";
import type { PreparedContext } from "../types";

export type CIFailureContext = {
  workflowName: string;
  workflowConclusion: string;
  workflowHtmlUrl: string;
  workflowRunId: number;
  headSha: string;
  headBranch: string;
};

export function generateCIFailureReviewPrompt(
  context: PreparedContext,
  ciContext: CIFailureContext,
): string {
  const basePrompt = generateReviewCandidatesPrompt(context);

  const ciPreamble = `## CI FAILURE CONTEXT — READ THIS FIRST

A CI workflow has **failed** on this PR. Your primary objective is to diagnose the failure and identify which code changes caused it.

* **Failed workflow**: ${ciContext.workflowName}
* **Conclusion**: ${ciContext.workflowConclusion}
* **Workflow run URL**: ${ciContext.workflowHtmlUrl}
* **Workflow run ID**: ${ciContext.workflowRunId}
* **Head SHA**: ${ciContext.headSha}
* **Head branch**: ${ciContext.headBranch}

### BEFORE reviewing code, you MUST:

1. Call \`get_ci_status\` with status "failure" to find all failed workflow runs.
2. For each failed run, call \`get_workflow_run_details\` (use run ID ${ciContext.workflowRunId} for the triggering failure) to find failed jobs and steps.
3. Call \`download_job_log\` for each failed job to get the actual error output.
4. Read the downloaded log files to extract the exact error messages, failing tests, or build errors.

Only after gathering the CI failure details should you proceed with the code review below. Focus your review on the code changes that are most likely to have caused the CI failure.

### Comment format for CI-caused issues

For issues directly tied to the CI failure, use this format instead of the standard [P0-P2] format:

\`[CI-FAIL] <Clear title describing the failure>\`

Then explain what failed in CI, why this code caused it, and how to fix it. Include the relevant CI error snippet.

### When CI failures are NOT caused by this PR

If after investigation you determine the failure is a flaky test, pre-existing on the base branch, or an infrastructure issue (timeout, network, runner), note this in your review summary and do not post inline comments for it.

---

`;

  return ciPreamble + basePrompt;
}
