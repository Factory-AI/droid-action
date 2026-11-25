/**
 * Writing rules for a finding's `body` and its optional fix outline, shared
 * by the candidate and validator prompts. The outline is rendered by
 * `fixMarkdown`, which turns anything outside its allowed Markdown into text.
 */
export function buildFindingTextSection(includeSuggestions: boolean): string {
  return `<finding_text>
Write each \`body\` as one short paragraph of plain prose. Put the direct claim first: what breaks, when, and why. Use the real identifiers from the diff. No headings, lists, hedging, or restating the code back to the author, and no code blocks${includeSuggestions ? " other than a `suggestion` block" : ""}. Use short words, cut every word you can, and prefer the active voice.

\`fix_markdown\` is an optional outline of the fix, shown under "Proposed fix". Use the smallest view that makes the fix clear:
- a \`diff\` fence of the changed lines, call tree, or state flow (most fixes);
- pseudocode for logic;
- a \`mermaid\` flowchart or sequenceDiagram for interaction or data flow;
- a whole code block only when most of it is new.
Only fenced code blocks, short list items, inline code, and plain sentences render. Headings, links, images, HTML, and \`suggestion\` fences turn into plain text.

\`fix_lines\` is your estimate of the production lines the fix adds plus removes. Set it whenever you write an outline; the comment then ends with "Estimated fix: ~N lines".

Leave out both fields unless you are confident the outline is right: a wrong outline costs more than none. When no small, concrete fix exists, leave out both fields and end \`body\` with one sentence that says so.${includeSuggestions ? "\n\nWhen a `suggestion` alone fixes the issue, leave out `fix_markdown` so the fix is not shown twice." : ""}

The whole comment must read in under 30 seconds. Example:

\`\`\`json
{
  "body": "\`saveDraft\` writes to the cache before \`validate\` runs, so a rejected draft still overwrites the last good copy. A reload then shows the rejected draft as if it had saved.",
  "fix_markdown": "\`\`\`diff\\n saveDraft\\n-  cache.write(draft)\\n   validate(draft)\\n+  cache.write(draft)\\n\`\`\`",
  "fix_lines": 2
}
\`\`\`
</finding_text>`;
}
