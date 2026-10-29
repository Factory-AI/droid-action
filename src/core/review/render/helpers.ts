import {
  CREDENTIAL_ENV_NAMES,
  redactSecrets as redactCredentialSecrets,
  secretValuesFromEnv,
} from "../../../utils/redact-credentials";

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
  return redactCredentialSecrets(
    text,
    secretValuesFromEnv([...CREDENTIAL_ENV_NAMES, "APP_PRIVATE_KEY"], env),
  )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|sk-(?:ant-)?[A-Za-z0-9_-]{8,}|fk_[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]",
    )
    .replace(
      /(\bauthorization\s*[:=]\s*(?:bearer|basic)?\s*)["']?[^\s,"';]+["']?/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:FACTORY_API_KEY|GITHUB_TOKEN|APP_PRIVATE_KEY|api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)["']?[^\s,"';]+["']?/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[REDACTED]@")
    .replace(
      /([?&](?:token|key|secret|password|signature|credential|access_token|api_key)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    );
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
