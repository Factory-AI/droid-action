import { escapeMarkdown, fenced, inlineCode, safeDiagram } from "./helpers";

/** Fence languages a fix outline may use; anything else, including `suggestion`, renders as text. */
const FIX_LANGUAGES = new Set([
  "text",
  "diff",
  "mermaid",
  "ts",
  "typescript",
  "tsx",
  "js",
  "javascript",
  "jsx",
  "py",
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "swift",
  "rb",
  "ruby",
  "php",
  "c",
  "cpp",
  "cs",
  "csharp",
  "sh",
  "bash",
  "shell",
  "sql",
  "json",
  "yaml",
  "toml",
]);

// CommonMark: a backtick fence's info string cannot contain a backtick, so
// "```js```" is inline code, not a fence opener.
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})[ \t]*([^\s`~]*)/;
const LIST_ITEM = /^( {0,6})([-*+]|\d{1,3}[.)])[ \t]+(.*)$/;

function closesFence(line: string, marker: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return (
    !!match && match[1]![0] === marker[0] && match[1]!.length >= marker.length
  );
}

function renderFence(language: string, body: string): string {
  if (!body.trim()) return "";
  const lang = language.toLowerCase();
  if (lang === "mermaid") {
    const diagram = safeDiagram(body);
    return diagram ? fenced(diagram, "mermaid") : fenced(body, "text");
  }
  return fenced(body, FIX_LANGUAGES.has(lang) ? lang : "text");
}

/** Escapes text but keeps `inline code` spans as code. */
function renderInline(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) =>
      i % 2 === 1 ? inlineCode(part.slice(1, -1)) : escapeMarkdown(part),
    )
    .join("");
}

function renderTextLine(line: string): string {
  const item = LIST_ITEM.exec(line);
  if (item) {
    const marker = /^\d/.test(item[2]!) ? item[2]! : "-";
    return `${item[1]}${marker} ${renderInline(item[3]!.trim())}`;
  }
  // A leading "-", "=" or "+" could start a rule, a setext heading or a list.
  return renderInline(line.trim()).replace(/^([-=+])/, "\\$1");
}

function renderText(lines: string[]): string {
  return lines
    .map((line) => (line.trim() ? renderTextLine(line) : ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Renders a model-written fix outline as Markdown that can hold only fenced
 * code, Mermaid that passes `safeDiagram`, list items, inline code and plain
 * text. Model output is untrusted: HTML (including hidden markers), links,
 * images, headings, mentions and `suggestion` fences never survive, and
 * every fence is rebuilt so an unclosed one cannot swallow the rest of the
 * comment. Returns null when nothing renderable remains.
 */
export function fixMarkdown(markdown: string): string | null {
  const blocks: string[] = [];
  let text: string[] = [];
  let fence: { marker: string; language: string; body: string[] } | null = null;
  const flushText = () => {
    const rendered = renderText(text);
    if (rendered) blocks.push(rendered);
    text = [];
  };
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      if (closesFence(line, fence.marker)) {
        blocks.push(renderFence(fence.language, fence.body.join("\n")));
        fence = null;
      } else {
        fence.body.push(line);
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      flushText();
      fence = { marker: open[1]!, language: open[2] ?? "", body: [] };
      continue;
    }
    text.push(line);
  }
  if (fence) blocks.push(renderFence(fence.language, fence.body.join("\n")));
  flushText();
  const out = blocks.filter(Boolean).join("\n\n");
  return out || null;
}
