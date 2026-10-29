import type { ReviewFinding } from "./validated/types";
import { normalizePatchPath } from "./validated/diff";

export type IncrementalReviewState = {
  head: string;
  paused?: boolean;
  autoRunCount?: number;
};

export type IncrementalReviewPlan = {
  incrementalBaseSha?: string;
  skipReason?: string;
};
export function identicalReviewDiffSkipReason(options: {
  full?: boolean;
  incrementalUsed: boolean;
  empty: boolean;
  hash: string;
  previousHash?: string;
  previousHead?: string;
}): string | undefined {
  if (options.full || !options.previousHead) return undefined;
  return (options.incrementalUsed && options.empty) ||
    (!options.incrementalUsed && options.previousHash === options.hash)
    ? `No new changes since ${options.previousHead.slice(0, 7)}`
    : undefined;
}

/** Manual reviews bypass pause and automatic-run limits, but not diff memory. */
export function planIncrementalReview(options: {
  state?: IncrementalReviewState | null;
  head: string;
  full?: boolean;
  automatic?: boolean;
  incremental?: boolean;
  maxAutoRuns?: number;
}): IncrementalReviewPlan {
  const { state } = options;
  if (options.automatic && state?.paused) {
    return {
      skipReason:
        "Automatic reviews are paused. Comment `@droid resume` to restart.",
    };
  }
  if (
    options.automatic &&
    (options.maxAutoRuns ?? 0) > 0 &&
    (state?.autoRunCount ?? 0) >= options.maxAutoRuns!
  ) {
    return {
      skipReason:
        "Automatic review limit reached. Comment `@droid review` to run manually or `@droid resume` to reset the limit.",
    };
  }
  if (!state?.head || options.full || options.incremental === false) return {};
  if (state.head === options.head) {
    return {
      incrementalBaseSha: state.head,
      skipReason: `No new changes since ${state.head.slice(0, 7)}`,
    };
  }
  return { incrementalBaseSha: state.head };
}

/** Only changed finding ranges are eligible for explicit fixed validation. */
export function changedFindingCandidates(
  findings: ReviewFinding[],
  diff: string,
): ReviewFinding[] {
  const index = changedReviewLines(diff);
  return findings.filter((finding) => {
    if (finding.state === "resolved" || finding.state === "dismissed")
      return false;
    const file =
      index.get(finding.oldPath ?? finding.path) ?? index.get(finding.path);
    if (!file) return false;
    if (finding.line === null) return true;
    const start = finding.startLine ?? finding.line;
    for (let line = start; line <= finding.line; line++) {
      if (file.oldLines.has(line)) return true;
    }
    return false;
  });
}

export type FindingThreadState = { findingId: string; resolved: boolean };

/** Old-side removals are the code previously reviewed, not unchanged hunk context. */
export function changedReviewLines(
  diff: string,
): Map<string, { oldLines: Set<number>; newLines: Set<number> }> {
  const result = new Map<
    string,
    { oldLines: Set<number>; newLines: Set<number> }
  >();
  let file: { oldLines: Set<number>; newLines: Set<number> } | undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = undefined;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      file = { oldLines: new Set(), newLines: new Set() };
      const name = normalizePatchPath(line.slice(4));
      if (name) result.set(name, file);
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const name = normalizePatchPath(line.slice(4));
      if (file && name) result.set(name, file);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!file || !inHunk) continue;
    if (line.startsWith("-")) {
      file.oldLines.add(oldLine++);
    } else if (line.startsWith("+")) {
      file.newLines.add(newLine++);
    } else if (line.startsWith(" ")) {
      oldLine++;
      newLine++;
    }
  }
  return result;
}

/** Absence from a new review never means fixed. Human resolutions win over the validator. */
export function reconcileFindings(options: {
  previous: ReviewFinding[];
  current: ReviewFinding[];
  threads?: FindingThreadState[];
  fixedIds?: string[];
  eligibleFixedIds?: string[];
  head: string;
  incremental?: boolean;
  changedPaths?: Set<string>;
}): {
  findings: ReviewFinding[];
  newFindings: ReviewFinding[];
  resolved: ReviewFinding[];
  unchangedSuggestions: number;
} {
  const resolvedThreads = new Set(
    options.threads?.filter((t) => t.resolved).map((t) => t.findingId),
  );
  const eligible = new Set(options.eligibleFixedIds ?? []);
  const currentIds = new Set(options.current.map((finding) => finding.id));
  const fixed = new Set(
    (options.fixedIds ?? []).filter(
      (id) => eligible.has(id) && !currentIds.has(id),
    ),
  );
  const byId = new Map<string, ReviewFinding>();
  const resolved: ReviewFinding[] = [];
  for (const finding of options.previous) {
    let next = { ...finding, isNew: false };
    if (resolvedThreads.has(finding.id) && finding.state !== "resolved") {
      next = { ...next, state: "dismissed" };
    } else if (fixed.has(finding.id) && finding.state !== "dismissed") {
      next = { ...next, state: "resolved", fixedIn: options.head };
      resolved.push(next);
    }
    byId.set(next.id, next);
  }
  let unchangedSuggestions = 0;
  const newFindings: ReviewFinding[] = [];
  for (const finding of options.current) {
    if (resolvedThreads.has(finding.id)) {
      byId.set(finding.id, {
        ...finding,
        ...byId.get(finding.id),
        state:
          byId.get(finding.id)?.state === "resolved" ? "resolved" : "dismissed",
      });
      continue;
    }
    const previous = byId.get(finding.id);
    if (previous) {
      byId.set(finding.id, {
        ...previous,
        ...finding,
        threadId: previous.threadId,
        threadUrl: previous.threadUrl,
        state: previous.state,
        fixedIn: previous.fixedIn,
        isNew: false,
      });
      continue;
    }
    if (
      options.incremental &&
      finding.severity === "P2" &&
      !finding.security &&
      finding.optionalSuggestion === true &&
      options.changedPaths &&
      !options.changedPaths.has(finding.path)
    ) {
      unchangedSuggestions++;
      continue;
    }
    const knownThread = options.threads?.some(
      (thread) => thread.findingId === finding.id,
    );
    const next: ReviewFinding = {
      ...finding,
      state: "open",
      isNew: !knownThread,
    };
    byId.set(next.id, next);
    if (!knownThread) newFindings.push(next);
  }
  return {
    findings: [...byId.values()],
    newFindings: newFindings.map((finding) => byId.get(finding.id)!),
    resolved,
    unchangedSuggestions,
  };
}
