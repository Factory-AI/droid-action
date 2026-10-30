import { createHash } from "node:crypto";
import type {
  FindingLocation,
  ReviewFinding,
  ReviewSummaryData,
} from "./types";

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function location(value: unknown): FindingLocation | undefined {
  const data = record(value);
  const path = nonempty(data?.path);
  if (!data || !path) return undefined;
  return {
    path,
    ...(positive(data.line) ? { line: positive(data.line) } : {}),
    ...(positive(data.startLine ?? data.start_line)
      ? { startLine: positive(data.startLine ?? data.start_line) }
      : {}),
  };
}

export function normalizeFinding(data: Record<string, unknown>): ReviewFinding {
  const rawBody = nonempty(data.body) ?? "";
  const legacyHeader = rawBody.split("\n", 1)[0] ?? "";
  const severity = data.severity ?? /^\[(P[012])\]/.exec(legacyHeader)?.[1];
  const title =
    nonempty(data.title) ??
    legacyHeader.replace(/^\[P[012]\]\s*(?:\[security\]\s*)?/i, "");
  const path = nonempty(data.path) ?? "";
  const oldPath = nonempty(data.oldPath ?? data.old_path);
  const side = data.side === "LEFT" ? "LEFT" : "RIGHT";
  const body = data.title
    ? rawBody
    : rawBody.slice(legacyHeader.length).trim() || title;
  const suggestionMatch = /```suggestion[^\n]*\n([\s\S]*?)\n```/.exec(body);
  // Replacement code is not prose: indentation, trailing newlines, and an
  // explicitly empty string (delete the selected lines) are all meaningful.
  const suggestion =
    typeof data.suggestion === "string"
      ? data.suggestion
      : suggestionMatch?.[1];
  const stableKey = `${path}\0${title.toLowerCase()}\0${data.side ?? "RIGHT"}`;
  const id =
    nonempty(data.id) ??
    `f-${createHash("sha256").update(stableKey).digest("hex").slice(0, 12)}`;
  const line =
    side === "LEFT"
      ? (positive(data.old_line) ?? positive(data.line) ?? null)
      : (positive(data.line) ?? null);
  const startLine = positive(data.startLine ?? data.start_line) ?? null;
  const source = location(data.source_guideline);
  const securitySeverity = data.securitySeverity ?? data.security_severity;
  return {
    id,
    title,
    severity: severity === "P0" || severity === "P1" ? severity : "P2",
    category:
      nonempty(data.category) ??
      (data.security === true || /\[security\]/i.test(legacyHeader)
        ? "security"
        : "correctness"),
    security: data.security === true || /\[security\]/i.test(legacyHeader),
    ...(securitySeverity === "critical" ||
    securitySeverity === "high" ||
    securitySeverity === "medium" ||
    securitySeverity === "low"
      ? { securitySeverity }
      : {}),
    ...(nonempty(data.cwe) ? { cwe: nonempty(data.cwe) } : {}),
    path,
    ...(oldPath ? { oldPath } : {}),
    line,
    startLine:
      startLine !== null && line !== null && startLine < line
        ? startLine
        : null,
    side,
    also_at: Array.isArray(data.also_at)
      ? data.also_at.flatMap((item) => {
          const parsed = location(item);
          return parsed ? [parsed] : [];
        })
      : [],
    body: body.replace(/```suggestion[^\n]*\n[\s\S]*?\n```/g, "").trim(),
    why: nonempty(data.why) ?? "",
    verification: nonempty(data.verification) ?? "",
    ...(suggestion !== undefined ? { suggestion } : {}),
    agent_prompt:
      nonempty(data.agent_prompt) ??
      `Verify ${side === "LEFT" ? (oldPath ?? path) : path}${line ? `:${line}` : ""}: ${title}. ${body}`,
    outside_diff: data.outside_diff === true || line === null,
    ...(typeof (data.optionalSuggestion ?? data.optional_suggestion) ===
    "boolean"
      ? {
          optionalSuggestion:
            (data.optionalSuggestion ?? data.optional_suggestion) === true,
        }
      : {}),
    ...(source ? { source_guideline: source } : {}),
  };
}

export function normalizeSummary(value: unknown): ReviewSummaryData {
  const data = record(value);
  if (!data) return {};
  const summary: ReviewSummaryData = {};
  const body = nonempty(data.body);
  const whatChanged = nonempty(data.whatChanged ?? data.what_changed);
  if (body) summary.body = body;
  if (whatChanged) summary.whatChanged = whatChanged;
  const risk = record(data.risk);
  if (
    risk &&
    (risk.level === "Low" ||
      risk.level === "Medium" ||
      risk.level === "High") &&
    nonempty(risk.reason)
  )
    summary.risk = { level: risk.level, reason: nonempty(risk.reason)! };
  const diagram = nonempty(data.diagram);
  if (diagram) summary.diagram = diagram;
  const effort = record(data.effort);
  if (
    effort &&
    typeof effort.score === "number" &&
    effort.score >= 1 &&
    effort.score <= 5
  )
    summary.effort = {
      score: effort.score,
      ...(positive(effort.minutes)
        ? { minutes: positive(effort.minutes) }
        : {}),
    };
  if (Array.isArray(data.suggestedReviewers))
    summary.suggestedReviewers = data.suggestedReviewers.filter(
      (v): v is string =>
        typeof v === "string" && /^[\w-]+(?:\/[\w-]+)?$/.test(v),
    );
  if (positive(data.filesReviewed) !== undefined || data.filesReviewed === 0)
    summary.filesReviewed = data.filesReviewed as number;
  if (Array.isArray(data.filesSkipped))
    summary.filesSkipped = data.filesSkipped.flatMap((v) => {
      const item = record(v);
      return item && nonempty(item.path) && nonempty(item.reason)
        ? [{ path: nonempty(item.path)!, reason: nonempty(item.reason)! }]
        : [];
    });
  if (Array.isArray(data.guidelines))
    summary.guidelines = data.guidelines.flatMap((v) => {
      const item = location(v);
      return item ? [item] : [];
    });
  if (Array.isArray(data.changes))
    summary.changes = data.changes.flatMap((v) => {
      const item = record(v);
      return item &&
        nonempty(item.area) &&
        nonempty(item.summary) &&
        Array.isArray(item.files)
        ? [
            {
              area: nonempty(item.area)!,
              summary: nonempty(item.summary)!,
              files: item.files.filter(
                (f): f is string => typeof f === "string" && !!f.trim(),
              ),
            },
          ]
        : [];
    });
  if (Array.isArray(data.preMergeChecks))
    summary.preMergeChecks = data.preMergeChecks.flatMap((v) => {
      const item = record(v);
      return item && nonempty(item.name) && typeof item.passed === "boolean"
        ? [
            {
              name: nonempty(item.name)!,
              passed: item.passed,
              ...(nonempty(item.reason)
                ? { reason: nonempty(item.reason) }
                : {}),
            },
          ]
        : [];
    });
  const security = record(data.security);
  if (security && typeof security.enabled === "boolean")
    summary.security = {
      enabled: security.enabled,
      ...(nonempty(security.threshold)
        ? { threshold: nonempty(security.threshold) }
        : {}),
      ...(typeof security.blockOnCritical === "boolean"
        ? { blockOnCritical: security.blockOnCritical }
        : {}),
      ...(typeof security.blockOnHigh === "boolean"
        ? { blockOnHigh: security.blockOnHigh }
        : {}),
    };
  return summary;
}
