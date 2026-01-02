import type { PreparedContext } from "../types";

export function generateFillPrompt(
  context: PreparedContext,
): string {
  const prNumber = context.eventData.isPR
    ? context.eventData.prNumber
    : context.githubContext && "entityNumber" in context.githubContext
      ? String(context.githubContext.entityNumber)
      : "unknown";

  const repoFullName = context.repository;

  return `You are updating the pull request description for PR #${prNumber} in ${repoFullName}.
The gh CLI is installed and authenticated via GH_TOKEN.

Procedure:
- Run: gh pr view ${prNumber} --repo ${repoFullName} --json title,body
- Run: gh pr view ${prNumber} --repo ${repoFullName} --json comments,reviews
- Run: gh pr diff ${prNumber} --repo ${repoFullName}
- Run: gh api repos/${repoFullName}/pulls/${prNumber}/files --paginate --jq '.[] | {filename,patch,additions,deletions}'
- Check for PR templates in the workspace; if the file exists, read it directly (e.g. using cat):
  * .github/PULL_REQUEST_TEMPLATE.md
  * .github/pull_request_template.md
  * .github/PULL_REQUEST_TEMPLATE
  * docs/pull_request_template.md
  * PULL_REQUEST_TEMPLATE.md
  If none exist locally, optionally fall back to gh api repos/${repoFullName}/contents/<path>

Use the gathered information to write the description:
- Base every statement on verified changes from the diff and context you collected.
- Preserve important details already present in the existing description (ticket numbers, custom sections, links, manual notes). If uncertain about a detail, keep it as-is.
- Remove any placeholder text such as "@droid fill" before submitting.
- Keep the tone concise and factual. Use clear Markdown headings/bullets.
- If a template is available, fill it out; otherwise structure the output as:
  ## Summary
  ## Changes
  ## Implementation Details (optional when not applicable)
  ## Testing
  ## Breaking Changes (only when relevant)
  ## Related Issues
- For sections you cannot verify, write "[To be filled by author]".

Submission:
- After drafting the final description, call github_pr___update_pr_description in replace mode with your Markdown body.
- Do not proceed if required commands fail. Instead, note the failure and provide whatever verified context you have.
`;
}
