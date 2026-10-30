import { redactCredentials } from "../../../utils/redact-credentials";

export function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
export function duration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return total >= 60
    ? `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`
    : `${total}s`;
}
/** Inject `env` to keep tests deterministic; publishing uses the job's credentials. */
export function redactSecrets(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return redactCredentials(text, env);
}
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
/** Model prose is text, never trusted Markdown/HTML or a source of bot mentions. */
export function escapeMarkdown(text: string): string {
  // Prose is HTML text, not an attribute. Encoding quotes before escaping
  // Markdown would corrupt the generated apostrophe entity's # character.
  return redactSecrets(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]{}()|#!>~])/g, "\\$1")
    .replace(/@/g, "@\u200b");
}
export function prose(text: string): string {
  return escapeMarkdown(text.replace(/\s+/g, " ").trim());
}
export function inlineCode(text: string): string {
  return `<code>${escapeHtml(redactSecrets(text)).replace(/\|/g, "&#124;").replace(/\n/g, " ")}</code>`;
}
export function wrapPath(path: string): string {
  return path.replace(/\//g, "/\u200b");
}
export function tablePath(path: string): string {
  return inlineCode(wrapPath(path));
}
export function relativeTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ""
    : `<relative-time datetime="${date.toISOString()}">${date.toISOString()}</relative-time>`;
}
export function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  value = redactSecrets(value);
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href.replace(
          /[()<>"\\]/g,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
        )
      : undefined;
  } catch {
    return /^#[a-zA-Z][\w-]*$/.test(value) ? value : undefined;
  }
}
export function link(label: string, url: string | undefined): string {
  const target = safeUrl(url);
  return target ? `[${label}](${target})` : label;
}
export function details(title: string, body: string, open = false): string {
  return body.trim()
    ? `<details${open ? " open" : ""}>\n<summary>${title}</summary>\n\n${body.trim()}\n\n</details>`
    : "";
}
/** Dynamic tilde fences let code and agent prompts contain arbitrary backticks and tildes. */
export function fenced(text: string, language = "text"): string {
  const content = redactSecrets(text);
  const runs = content.match(/~+/g) ?? [];
  const fence = "~".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}${language}\n${content}\n${fence}`;
}
export function stripSummaryMarkers(body: string): string {
  return body
    .replace(/<!--\s*droid-review-(?:summary|state):v1[\s\S]*?-->/g, "")
    .trim();
}
