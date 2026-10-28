import type { ReviewSummaryData } from "./types";

export type ReviewMetadataInput = {
  changedPaths: string[];
  title: string;
  description: string;
  /** Content fetched from the immutable base commit, never the PR worktree. */
  codeowners?: string;
  suggestReviewers?: boolean;
  /** Optional provider-verified user/team allowlist; unknown owners are omitted. */
  availableReviewers?: string[];
  includeEffort?: boolean;
  preMergeChecks?: Array<"title" | "description" | "linked_issue">;
  ignoredPaths?: Array<{ path: string; reason: string }>;
  security?: NonNullable<ReviewSummaryData["security"]>;
};

function codeownersTokens(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of line) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "#") break;
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function matchesCodeownersPattern(pattern: string, filePath: string): boolean {
  // CODEOWNERS deliberately does not support gitignore negation or [] ranges.
  if (!pattern || /^[!#]/.test(pattern) || /[\[\]]/.test(pattern)) return false;
  const anchored = pattern.startsWith("/");
  const directory = pattern.endsWith("/");
  const normalized = pattern.replace(/^\//, "").replace(/\/$/, "");
  if (!normalized) return false;
  const rootRelative = anchored || normalized.includes("/");
  const glob = rootRelative ? normalized : `**/${normalized}`;
  return (
    (!directory && new Bun.Glob(glob).match(filePath)) ||
    new Bun.Glob(`${glob}/**`).match(filePath)
  );
}

/** Last matching rule wins per file, including an explicit rule with no owners. */
export function suggestedReviewersFromCodeowners(
  content: string,
  changedPaths: string[],
  availableReviewers?: string[],
): string[] {
  if (Buffer.byteLength(content, "utf8") > 3 * 1024 * 1024) return [];
  const rules = content.split(/\r?\n/).flatMap((line) => {
    const [pattern, ...rawOwners] = codeownersTokens(line);
    if (!pattern) return [];
    const owners = rawOwners
      .filter((owner) =>
        /^@[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*$/.test(owner),
      )
      .map((owner) => owner.slice(1));
    return [{ pattern, owners }];
  });
  const available = availableReviewers
    ? new Set(availableReviewers.map((owner) => owner.replace(/^@/, "")))
    : null;
  const suggestions = new Set<string>();
  for (const rawPath of changedPaths) {
    const filePath = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!filePath || filePath.split("/").includes("..")) continue;
    let owners: string[] = [];
    for (const rule of rules) {
      if (matchesCodeownersPattern(rule.pattern, filePath))
        owners = rule.owners;
    }
    for (const owner of owners)
      if (!available || available.has(owner)) suggestions.add(owner);
  }
  return [...suggestions].sort();
}

function visibleDescription(description: string): string {
  return description
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "")
    .trim();
}

/** Deterministic, opt-in metadata. Does not assign or request reviewers or perform I/O. */
export function enrichReviewSummary(
  summary: ReviewSummaryData,
  input: ReviewMetadataInput,
): ReviewSummaryData {
  const result: ReviewSummaryData = { ...summary };
  const ignored = new Map(
    (input.ignoredPaths ?? []).map((file) => [file.path, file]),
  );
  for (const file of summary.filesSkipped ?? [])
    if (!ignored.has(file.path)) ignored.set(file.path, file);
  const changedPaths = [...new Set(input.changedPaths)];
  const reviewedPaths = changedPaths.filter(
    (filePath) => !ignored.has(filePath),
  );
  result.filesReviewed = reviewedPaths.length;
  if (ignored.size) result.filesSkipped = [...ignored.values()];
  else delete result.filesSkipped;
  if (!input.includeEffort) delete result.effort;
  if (input.suggestReviewers && input.codeowners) {
    const reviewers = suggestedReviewersFromCodeowners(
      input.codeowners,
      reviewedPaths,
      input.availableReviewers,
    );
    if (reviewers.length) result.suggestedReviewers = reviewers;
    else delete result.suggestedReviewers;
  } else delete result.suggestedReviewers;
  const checks: NonNullable<ReviewSummaryData["preMergeChecks"]> = [];
  const title = input.title.trim();
  const description = visibleDescription(input.description);
  for (const check of input.preMergeChecks ?? []) {
    if (check === "title") {
      const passed =
        title.length >= 10 &&
        title.length <= 120 &&
        !/^(?:wip|draft|todo|test|update|changes?)[:.! ]*$/i.test(title);
      checks.push({
        name: "Title",
        passed,
        reason: passed
          ? "A descriptive title is present."
          : "Use a descriptive title between 10 and 120 characters.",
      });
    } else if (check === "description") {
      const passed =
        description.length >= 20 &&
        !/^(?:todo|tbd|n\/a|none)[.! ]*$/i.test(description);
      checks.push({
        name: "Description",
        passed,
        reason: passed
          ? "The description includes review context."
          : "Add a description explaining the change and its validation.",
      });
    } else {
      const passed =
        /(?:^|[\s(])(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+\b|https?:\/\/[^\s)]+\/(?:issues|work_items)\/\d+\b|\b[A-Z][A-Z0-9]{1,9}-\d+\b/.test(
          description,
        );
      checks.push({
        name: "Linked issue",
        passed,
        reason: passed
          ? "The description references a tracking issue."
          : "Link the tracking issue in the description.",
      });
    }
  }
  if (checks.length) result.preMergeChecks = checks;
  else delete result.preMergeChecks;
  if (input.security) result.security = input.security;
  return result;
}
