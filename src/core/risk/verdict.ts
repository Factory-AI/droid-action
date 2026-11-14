import { z } from "zod";
import type { RiskScoreRanges } from "./types";

// A model cannot count characters, so an overrun is cut with a marker rather
// than rejected, and the verdict it carries still lands.
const BRIEF_MAX_CHARS = 800;
const DETAILS_MAX_CHARS = 6_000;
const TRUNCATION_MARK = "…";

function truncatedMarkdown(max: number) {
  return z
    .string()
    .min(1)
    .transform((value) =>
      value.length > max
        ? `${value.slice(0, max - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`
        : value,
    );
}

/**
 * A validated judge answer. `brief` is the short text shown under the
 * headline and `details` the longer body beneath it. `scores` is present only
 * when the judge declares any.
 */
export type PrRiskVerdict = {
  verdict: boolean;
  brief: string;
  details: string;
  scores?: Record<string, number>;
};

/**
 * The JSON contract a judge must answer: `verdict`, `brief`, `details`, and
 * every declared score within its range, and nothing else. Strict so a
 * drifting answer is a retry, never a silently narrowed verdict; only length
 * is forgiven, by truncation.
 */
export function compilePrRiskVerdictSchema(
  scores: RiskScoreRanges,
): z.ZodType<PrRiskVerdict, z.ZodTypeDef, unknown> {
  const core = z.object({
    verdict: z.boolean(),
    brief: truncatedMarkdown(BRIEF_MAX_CHARS),
    details: truncatedMarkdown(DETAILS_MAX_CHARS),
  });
  const entries = Object.entries(scores);
  if (entries.length === 0) return core.strict();
  return core
    .extend({
      scores: z
        .object(
          Object.fromEntries(
            entries.map(([name, [min, max]]) => [
              name,
              z.number().int().min(min).max(max),
            ]),
          ),
        )
        .strict(),
    })
    .strict();
}

/** The exact keys a retry must return, stated from the compiled contract. */
export function describePrRiskContract(scores: RiskScoreRanges): string {
  const names = Object.entries(scores);
  return [
    "verdict (boolean)",
    `brief (string; one to three Markdown bullets shown under the headline, cut at ${BRIEF_MAX_CHARS} characters)`,
    `details (string; the Markdown body of the "Why this decision" drawer, cut at ${DETAILS_MAX_CHARS} characters)`,
    ...(names.length > 0
      ? [
          `scores (object with exactly these integer keys: ${names
            .map(([name, [min, max]]) => `${name} ${min}-${max}`)
            .join(", ")})`,
        ]
      : []),
  ]
    .map((line) => `- ${line}`)
    .join("\n");
}

const FENCED_JSON_OPENER = /```json[ \t]*\r?\n[ \t\r\n]*/g;

/**
 * The object opening at `openIndex`, or null when it never balances. The scan
 * is JSON-string-aware so braces inside quoted values (models routinely
 * mention code in their reasoning) do not skew the depth.
 */
function balancedObjectAt(text: string, openIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (inString) {
      if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(openIndex, index + 1);
      }
    }
  }
  return null;
}

/**
 * The last balanced object, then each object enclosing it, innermost first.
 * The last `{` of a bare verdict whose fields hold objects opens one of those
 * fields, so the verdict itself is only reached by walking outward.
 */
function trailingBalancedObjects(text: string): string[] {
  const objects: string[] = [];
  let end = -1;
  for (
    let openIndex = text.lastIndexOf("{");
    openIndex !== -1;
    // lastIndexOf clamps a negative fromIndex to 0, which would revisit 0.
    openIndex = openIndex === 0 ? -1 : text.lastIndexOf("{", openIndex - 1)
  ) {
    const object = balancedObjectAt(text, openIndex);
    if (object === null) continue;
    const objectEnd = openIndex + object.length;
    // An object ending before the current one is an earlier sibling, not
    // part of the trailing verdict.
    if (objectEnd < end) continue;
    objects.push(object);
    end = objectEnd;
  }
  return objects;
}

/**
 * JSON candidates from a session's final message, most authoritative first:
 * fenced ```json blocks in reverse order, then the last balanced object and
 * the objects enclosing it. A fenced block is read by balancing its object,
 * not by searching for the closing fence: a verdict whose strings quote a
 * code fence would otherwise be cut at the inner fence and never parse.
 */
export function extractJsonCandidates(output: string): string[] {
  const candidates: string[] = [];
  for (const match of output.matchAll(FENCED_JSON_OPENER)) {
    const openIndex = match.index + match[0].length;
    if (output[openIndex] !== "{") continue;
    const object = balancedObjectAt(output, openIndex);
    if (object) candidates.push(object);
  }
  candidates.reverse();
  // Unfenced fallback last: a stray balanced object trailing the final fenced
  // verdict must not outrank the block the prompt demanded.
  candidates.push(...trailingBalancedObjects(output));
  return candidates;
}
