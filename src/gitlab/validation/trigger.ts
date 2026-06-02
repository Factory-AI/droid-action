/**
 * Detect whether an MR's title / description / labels contain the
 * `@droid fill` trigger phrase.
 */

export type FillTriggerSource =
  | "description"
  | "title"
  | "label"
  | "automatic_fill"
  | "none";

export type FillTriggerResult = {
  matched: boolean;
  source: FillTriggerSource;
};

export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex that matches `<triggerPhrase> fill` with word-ish
 * boundaries. Case-insensitive. Accepts `@droid fill`,
 * `@droid   fill`, `@Droid fill`, etc.
 */
export function buildFillRegex(triggerPhrase: string): RegExp {
  const escaped = escapeRegExp(triggerPhrase);
  return new RegExp(`(^|\\s)${escaped}\\s+fill([\\s.,!?;:]|$)`, "i");
}

/**
 * Standard label form: `droid:fill` (case-insensitive).
 */
function labelMatchesFill(labels: string[]): boolean {
  return labels.some((l) => l.trim().toLowerCase() === "droid:fill");
}

export function checkContainsFillTrigger(args: {
  description: string | null;
  title: string | null;
  labels: string[];
  triggerPhrase: string;
  automaticFill: boolean;
}): FillTriggerResult {
  const { description, title, labels, triggerPhrase, automaticFill } = args;
  const regex = buildFillRegex(triggerPhrase);

  if (description && regex.test(description)) {
    return { matched: true, source: "description" };
  }

  if (title && regex.test(title)) {
    return { matched: true, source: "title" };
  }

  if (labelMatchesFill(labels)) {
    return { matched: true, source: "label" };
  }

  if (automaticFill) {
    return { matched: true, source: "automatic_fill" };
  }

  return { matched: false, source: "none" };
}

/**
 * Strip the literal `<triggerPhrase> fill` token from a description so
 * the next `merge_request_event` (fired by our own description update)
 * does not re-fire the fill job. Whitespace around the match is
 * collapsed.
 */
export function stripFillTrigger(
  description: string,
  triggerPhrase: string,
): string {
  const escaped = escapeRegExp(triggerPhrase);
  const regex = new RegExp(`\\s*${escaped}\\s+fill\\s*`, "gi");
  return description
    .replace(regex, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
