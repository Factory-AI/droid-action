/**
 * Prompt for the `@droid fill` mode on GitLab MRs. Mirrors the GitHub
 * action's fill-prompt but writes back via the GitLab MCP server's
 * `update_mr_description` tool instead of `update_pr_description`.
 */

export type GitlabFillPromptContext = {
  projectPath: string;
  mrIid: number;
  mrTitle: string;
  sourceBranch: string;
  targetBranch: string;
  triggerSource: "description" | "title" | "label" | "automatic_fill" | "none";
  triggerPhrase: string;
  descriptionPath: string;
  diffPath: string;
};

export function generateGitlabFillPrompt(ctx: GitlabFillPromptContext): string {
  return `You are updating the description of merge request !${ctx.mrIid} in ${ctx.projectPath}.

## MR details
* Title: ${ctx.mrTitle}
* Source branch: ${ctx.sourceBranch}
* Target branch: ${ctx.targetBranch}
* Trigger: \`${ctx.triggerPhrase} fill\` detected via **${ctx.triggerSource}**

## Inputs already on disk
* Current description: \`${ctx.descriptionPath}\` (may contain \`${ctx.triggerPhrase} fill\` as placeholder text)
* Full unified diff: \`${ctx.diffPath}\`

## Procedure
1. Read \`${ctx.descriptionPath}\` and \`${ctx.diffPath}\` to ground every claim in verified changes.
2. Check the workspace for an MR description template:
   * \`.gitlab/merge_request_templates/Default.md\`
   * \`.gitlab/merge_request_templates/default.md\`
   * Any other file under \`.gitlab/merge_request_templates/\` (use the first match)
   If one exists, fill out its sections. Otherwise use:
   \`\`\`
   ## Summary
   ## Changes
   ## Implementation Details (optional when not applicable)
   ## Testing
   ## Breaking Changes (only when relevant)
   \`\`\`
3. Preserve any non-placeholder content already in the existing description (ticket links, custom sections, manual notes). If a detail is uncertain, keep it as-is.
4. Do **not** infer or invent ticket references (Linear, Jira, GitLab issues, etc.) that are not already explicitly present in the existing description, MR comments, or branch name. Never extract ticket IDs from commit messages or other indirect sources. If no ticket is linked, leave the section empty or omit it.
5. **Strip the trigger phrase.** Remove any literal occurrence of \`${ctx.triggerPhrase} fill\` from the new description so the next \`merge_request_event\` (fired by this update) does not re-trigger fill mode.
6. Keep the tone concise and factual. Use clear Markdown headings and bullets. For sections you cannot verify, write \`[To be filled by author]\`.

## Submission
* Call \`gitlab_mr___update_mr_description\` with the final Markdown body and \`mr_iid: ${ctx.mrIid}\`. This is the only mutation tool available in this pass.
* Do **not** post inline review comments, summary notes, or anything else. Fill mode is description-only.
* Do **not** call \`update_mr_description\` more than once. Compose the final body in one go and submit it.

## Hard constraints
* Output must be Markdown — no surrounding code fence, no commentary.
* Do not modify any files other than the MR description.
* If the diff is empty or unreadable, abort with a clear error message and do **not** call \`update_mr_description\`.
`;
}
