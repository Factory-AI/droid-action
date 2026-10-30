import { record } from "../validated/finding";
import { normalizeFinding } from "../validated/finding";
import type { ReviewFinding, ReviewSeverity } from "../validated/types";
import { redactSecrets } from "../render/helpers";

export const SUMMARY_MARKER = "<!-- droid-review-summary:v1 -->";
export type ReviewStateFinding = {
  id: string;
  sev: ReviewSeverity;
  thread?: string | number;
  state: "open" | "resolved" | "dismissed";
  path?: string;
  line?: number;
  title?: string;
  body?: string;
  /** GraphQL discussion node ID. `thread` remains the legacy numeric comment ID. */
  threadId?: string;
  commentId?: number;
  url?: string;
  finding?: ReviewFinding;
};
export type ReviewState = {
  head: string;
  base?: string;
  reviewed?: string[];
  findings: ReviewStateFinding[];
  depth?: string;
  paused?: boolean;
  autoRunCount?: number;
  diffHash?: string;
  /** Completed security analysis, bound to the reviewed source revision. */
  securityReviewedHead?: string;
};
export type FindingMarker = {
  id: string;
  sev: ReviewSeverity;
  cat?: string;
  head?: string;
};
export type ReviewMarker = { head: string; stale?: boolean };
export type SeverityCounts = {
  p0: number;
  p1: number;
  p2: number;
  security: number;
};

/** Escaping comment terminators prevents payload text from creating visible markup. */
function jsonMarker(name: string, value: unknown): string {
  return `<!-- ${name} ${JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "string" ? redactSecrets(item) : item,
  )
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")} -->`;
}

/**
 * Machine markers are standalone top-level HTML comments, never examples in
 * model-written agent prompts, code spans, blockquotes, or collapsed details.
 * Do not search raw Markdown: an earlier fenced example is untrusted data.
 */
function topLevelCommentSpans(
  body: string,
): Array<{ text: string; start: number; end: number }> {
  const comments: Array<{ text: string; start: number; end: number }> = [];
  const lines = [...body.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/g)].filter(
    (line) => line[0].length > 0,
  );
  let fence: { char: string; length: number } | null = null;
  let inlineTicks = 0;
  let detailsDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]![1]!;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1]![0] === fence.char &&
        fenceMatch[1]!.length >= fence.length &&
        !fenceMatch[2]!.trim()
      )
        fence = null;
      continue;
    }
    if (/^(?: {0,3}>| {4}|\t)/.test(line)) continue;
    if (fenceMatch && inlineTicks === 0) {
      fence = { char: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      continue;
    }
    if (!line.trim()) {
      inlineTicks = 0;
      continue;
    }
    if (inlineTicks === 0 && /^ {0,3}<!--/.test(line)) {
      const parts = [line.trimStart()];
      let end = i;
      while (!parts.at(-1)!.includes("-->") && end + 1 < lines.length) {
        // A truncated hand-edited marker must not swallow a later real one.
        if (/^ {0,3}<!--/.test(lines[end + 1]![1]!)) break;
        parts.push(lines[++end]![1]!);
      }
      const comment = parts.join("\n");
      if (/-->[ \t]*$/.test(comment)) {
        if (detailsDepth === 0)
          comments.push({
            text: comment.trimEnd(),
            start: lines[i]!.index! + line.length - line.trimStart().length,
            end: lines[end]!.index! + lines[end]![1]!.trimEnd().length,
          });
        i = end;
        continue;
      }
    }
    // Backtick runs delimit inline code, including code spans across lines.
    for (const match of line.matchAll(/`+/g)) {
      const prefix = line.slice(0, match.index).match(/\\+$/)?.[0].length ?? 0;
      if (prefix % 2) continue;
      if (inlineTicks === 0) inlineTicks = match[0].length;
      else if (match[0].length === inlineTicks) inlineTicks = 0;
    }
    if (inlineTicks === 0) {
      for (const match of line.matchAll(/<\/?details(?:\s[^>]*)?>/g)) {
        detailsDepth = Math.max(
          0,
          detailsDepth + (match[0].startsWith("</") ? -1 : 1),
        );
      }
    }
  }
  return comments;
}

function topLevelComments(body: string): string[] {
  return topLevelCommentSpans(body).map((comment) => comment.text);
}

/** Examples and ambiguous competing sessions never establish ownership. */
export function hasReviewSessionMarker(body: string, marker: string): boolean {
  const sessions = topLevelComments(body).filter((comment) =>
    /^<!-- droid-review-(?:active|completed):v1 /.test(comment),
  );
  return sessions.length === 1 && sessions[0] === marker;
}

/** Historical review text must not carry a prior session into a new summary. */
export function stripReviewSessionMarkers(body: string): string {
  const sessions = topLevelCommentSpans(body).filter((comment) =>
    /^<!-- droid-review-(?:active|completed):v1 /.test(comment.text),
  );
  for (const session of sessions.reverse())
    body = body.slice(0, session.start) + body.slice(session.end);
  return body;
}

/** Trusted standalone delimiter pair. Offsets address the original, unnormalized body. */
export function findTopLevelCommentRange(
  body: string,
  startMarker: string,
  endMarker: string,
): { start: number; end: number } | null {
  const markers = topLevelCommentSpans(body).filter(
    (comment) => comment.text === startMarker || comment.text === endMarker,
  );
  if (!markers.length) return null;
  if (
    markers.length !== 2 ||
    markers[0]!.text !== startMarker ||
    markers[1]!.text !== endMarker
  )
    throw new Error(
      "Description markers are incomplete or ambiguous; refusing to overwrite author text.",
    );
  return { start: markers[0]!.start, end: markers[1]!.end };
}

/** End is exclusive. Examples never claim ownership of author-written descriptions. */
export function findReviewSummaryRange(
  body: string,
  platform: "github" | "gitlab",
): { start: number; end: number } | null {
  const name =
    platform === "github" ? "droid-review-summary" : "droid-review-description";
  return findTopLevelCommentRange(
    body,
    `<!-- ${name}:start -->`,
    `<!-- ${name}:end -->`,
  );
}

function readJson(body: string, name: string): Record<string, unknown> | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^<!--\\s*${escaped}\\s+(\\{[\\s\\S]*?\\})\\s*-->$`,
  );
  for (const comment of topLevelComments(body)) {
    const match = pattern.exec(comment);
    if (!match) continue;
    try {
      const value = record(JSON.parse(match[1]!));
      if (value) return value;
    } catch {
      // A hand-edited or truncated marker must not prevent finding a later valid marker.
    }
  }
  return null;
}

export function hasSummaryMarker(body: string): boolean {
  return topLevelComments(body).some((comment) =>
    /^<!--\s*droid-review-summary:v1\s*-->$/.test(comment),
  );
}
export function encodeReviewState(state: ReviewState): string {
  return jsonMarker("droid-review-state:v1", state);
}
export function decodeReviewState(body: string): ReviewState | null {
  const value = readJson(body, "droid-review-state:v1");
  if (
    !value ||
    typeof value.head !== "string" ||
    !Array.isArray(value.findings)
  )
    return null;
  const findings: ReviewStateFinding[] = value.findings.flatMap((raw) => {
    const f = record(raw);
    if (
      !f ||
      typeof f.id !== "string" ||
      !["P0", "P1", "P2"].includes(String(f.sev)) ||
      !["open", "resolved", "dismissed"].includes(String(f.state))
    )
      return [];
    return [
      {
        id: f.id,
        sev: f.sev as ReviewSeverity,
        state: f.state as ReviewStateFinding["state"],
        ...(typeof f.thread === "string" || typeof f.thread === "number"
          ? { thread: f.thread }
          : {}),
        ...(typeof f.path === "string" ? { path: f.path } : {}),
        ...(typeof f.line === "number" &&
        Number.isSafeInteger(f.line) &&
        f.line > 0
          ? { line: f.line }
          : {}),
        ...(typeof f.title === "string" ? { title: f.title } : {}),
        ...(typeof f.body === "string" ? { body: f.body } : {}),
        ...(typeof f.threadId === "string" ? { threadId: f.threadId } : {}),
        ...(typeof f.commentId === "number" &&
        Number.isSafeInteger(f.commentId) &&
        f.commentId > 0
          ? { commentId: f.commentId }
          : {}),
        ...(typeof f.url === "string" ? { url: f.url } : {}),
        ...(record(f.finding) &&
        typeof record(f.finding)?.path === "string" &&
        typeof record(f.finding)?.body === "string"
          ? {
              finding: {
                ...normalizeFinding(record(f.finding)!),
                ...(typeof record(f.finding)?.threadUrl === "string"
                  ? { threadUrl: String(record(f.finding)?.threadUrl) }
                  : {}),
                ...(typeof record(f.finding)?.fixedIn === "string" &&
                /^[a-f0-9]{7,64}$/i.test(String(record(f.finding)?.fixedIn))
                  ? { fixedIn: String(record(f.finding)?.fixedIn) }
                  : {}),
                ...(record(f.finding)?.pendingThreadAction === "resolve"
                  ? { pendingThreadAction: "resolve" as const }
                  : record(f.finding)?.pendingThreadAction === "reopen"
                    ? { pendingThreadAction: "reopen" as const }
                    : {}),
              },
            }
          : {}),
      },
    ];
  });
  return {
    head: value.head,
    findings,
    ...(typeof value.base === "string" ? { base: value.base } : {}),
    ...(typeof value.depth === "string" ? { depth: value.depth } : {}),
    ...(typeof value.diffHash === "string" ? { diffHash: value.diffHash } : {}),
    ...(Array.isArray(value.reviewed)
      ? {
          reviewed: value.reviewed.filter(
            (v): v is string => typeof v === "string",
          ),
        }
      : {}),
    ...(typeof value.paused === "boolean" ? { paused: value.paused } : {}),
    ...(typeof value.securityReviewedHead === "string" &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.securityReviewedHead)
      ? { securityReviewedHead: value.securityReviewedHead }
      : {}),
    ...(typeof value.autoRunCount === "number" &&
    Number.isSafeInteger(value.autoRunCount) &&
    value.autoRunCount >= 0
      ? { autoRunCount: value.autoRunCount }
      : {}),
  };
}
export function encodeFindingMarker(marker: FindingMarker): string {
  return jsonMarker("droid-finding:v1", marker);
}
export function decodeFindingMarker(body: string): FindingMarker | null {
  const value = readJson(body, "droid-finding:v1");
  if (
    !value ||
    typeof value.id !== "string" ||
    !["P0", "P1", "P2"].includes(String(value.sev))
  )
    return null;
  return {
    id: value.id,
    sev: value.sev as ReviewSeverity,
    ...(typeof value.cat === "string" ? { cat: value.cat } : {}),
    ...(typeof value.head === "string" ? { head: value.head } : {}),
  };
}
export function encodeReviewMarker(marker: ReviewMarker): string {
  return `<!-- droid-review:v1 head=${marker.head.replace(/[^a-zA-Z0-9_-]/g, "")}${marker.stale ? " stale" : ""} -->`;
}
export function decodeReviewMarker(body: string): ReviewMarker | null {
  for (const comment of topLevelComments(body)) {
    const match =
      /^<!--\s*droid-review:v1\s+head=([a-zA-Z0-9_-]+)(\s+stale)?\s*-->$/.exec(
        comment,
      );
    if (match) return { head: match[1]!, ...(match[2] ? { stale: true } : {}) };
  }
  return null;
}
export function encodeSeverityMarker(counts: SeverityCounts): string {
  return jsonMarker("droid-severity:", counts);
}
export function decodeSeverityMarker(body: string): SeverityCounts | null {
  const value =
    readJson(body, "droid-severity:") ?? readJson(body, "droid-severity:v1");
  if (
    !value ||
    !["p0", "p1", "p2", "security"].every(
      (k) =>
        typeof value[k] === "number" &&
        Number.isSafeInteger(value[k]) &&
        value[k] >= 0,
    )
  )
    return null;
  return {
    p0: Number(value.p0),
    p1: Number(value.p1),
    p2: Number(value.p2),
    security: Number(value.security),
  };
}
