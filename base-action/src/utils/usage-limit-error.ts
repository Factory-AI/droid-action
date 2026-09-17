/**
 * Matches the 402 Payment Required failures droid exec surfaces when the
 * organization has hit a usage limit (5-hour / weekly / monthly standard or
 * Droid Core limit, exhausted Extra Usage, credit limit) or, on BYOK models,
 * when the upstream provider reports an empty balance.
 *
 * In stream-json mode the CLI reports the raw error as
 * `{"type":"error","source":"agent_loop","message":"402 {...}"}` where the
 * JSON body carries a human-readable `detail`. The copy-based patterns are a
 * fallback for wrappers that drop the status prefix.
 */
const USAGE_LIMIT_COPY_PATTERNS = [
  /reached your [^\n"]*usage limit/i,
  /credit limit reached/i,
  /extra usage balance is empty/i,
  /model budget is exhausted/i,
];

export function isUsageLimitError(text: string | undefined | null): boolean {
  if (!text) {
    return false;
  }
  if (/^(?:Error:\s*)?402\b/.test(text.trim())) {
    return true;
  }
  if (/"status"\s*:\s*402\b/.test(text)) {
    return true;
  }
  return USAGE_LIMIT_COPY_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Pull the human-readable `detail` out of a `402 {"detail":"...",...}` error
 * message so the PR comment shows "You've reached your weekly ... usage
 * limit" instead of a JSON blob. Falls back to the raw text.
 */
export function describeUsageLimitError(text: string): string {
  const jsonStart = text.indexOf("{");
  if (jsonStart !== -1) {
    try {
      const body: unknown = JSON.parse(text.slice(jsonStart));
      if (
        typeof body === "object" &&
        body !== null &&
        typeof (body as { detail?: unknown }).detail === "string"
      ) {
        const detail = (body as { detail: string }).detail.trim();
        if (detail) {
          return detail;
        }
      }
    } catch {
      // Not a JSON body; fall through to the raw text.
    }
  }
  return text.trim();
}
