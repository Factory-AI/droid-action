/**
 * Matches the 403 errors returned by the Factory API when a request uses a
 * model that the organization's model policy does not allow, including the
 * explicit opt-in variant ("This model requires explicit organization
 * opt-in by an admin.").
 */
const MODEL_POLICY_ERROR_PATTERNS = [
  /not available due to your organization['’]s security settings/i,
  /requires explicit organization opt-in/i,
];

export function isModelPolicyError(text: string | undefined | null): boolean {
  if (!text) {
    return false;
  }
  return MODEL_POLICY_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Matches the fast client-side failure droid exec prints to stderr when the
 * --model value is not a recognized model id.
 */
export function isInvalidModelError(text: string | undefined | null): boolean {
  if (!text) {
    return false;
  }
  return /Invalid model:/i.test(text);
}

/**
 * An invalid --model value makes droid exec dump the full list of available
 * models (twice, with one line per dump that is hundreds of characters
 * wide). Condense that output down to the meaningful lines so it can be
 * embedded in a PR comment without sideways scrolling.
 */
export function condenseInvalidModelError(text: string): string {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^Available built-in models:$/i.test(trimmed)) continue;
    if (/^No custom models configured/i.test(trimmed)) continue;
    // Drop raw model-list dumps (long comma-separated lines)
    if (trimmed.split(", ").length >= 5) continue;
    if (kept[kept.length - 1] === trimmed) continue;
    kept.push(trimmed);
  }
  const condensed = kept.join("\n");
  return condensed || text;
}

/**
 * Remove `--model <value>` and `--reasoning-effort <value>` (including
 * `--flag=value` forms) from an argv array so droid exec falls back to the
 * organization's default model.
 */
export function stripModelArgs(args: string[]): string[] {
  const stripped: string[] = [];
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "--model" || arg === "--reasoning-effort") {
      skipNext = true;
      continue;
    }
    if (arg.startsWith("--model=") || arg.startsWith("--reasoning-effort=")) {
      continue;
    }
    stripped.push(arg);
  }

  return stripped;
}
