import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  normalizePatchPath,
  pathsFromDiffHeader,
} from "../review/validated/diff";
import { TEST_PATH } from "./snapshot";
import type { PrRiskFocus, PrRiskFocusPath, RiskIncremental } from "./types";

// Lines that add or remove an exported declaration or a callable signature:
// a change consumers outside the edited file may depend on.
const EXPORT_LINE =
  /^[+-]\s*export\s+(default\s+)?(async\s+)?(function|const|let|class|type|interface|enum|abstract|\{|\*)/;
const SIGNATURE_LINE =
  /^[+-]\s*(export\s+)?(async\s+)?function\s+\w+\s*\(|^[+-]\s*(public|private|protected)?\s*\w+\s*\([^)]*\)\s*[:{]|z\.(object|enum|union|literal|string|number|boolean|array)\(/;
const DECLARATION =
  /^[+-]\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var|def|func)\s+([A-Za-z_$][\w$]*)/;
const HUNK_CONTEXT =
  /^@@[^@]*@@\s*(?:.*?\b(?:function\*?|class|interface|type|enum|const|let|def|func)\s+)?([A-Za-z_$][\w$]*)/;
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const MAX_SYMBOLS_PER_PATH = 20;
const MAX_IMPORTERS_PER_PATH = 20;
const MAX_TESTS = 50;
// A pathspec list past this is too long for one git command line; the
// incremental judgment falls back to a full one.
export const MAX_INCREMENTAL_PATHS = 1000;

/** One file's section of a unified diff, keyed by its path at the newer side. */
type DiffFile = { path: string; previousPath?: string; footprint: string };

/**
 * Splits a unified diff into per-file footprints: what the file's change
 * adds and removes, and how it changes the file itself (created, deleted,
 * renamed, mode, binary content). Hunk positions and context lines are left
 * out, so the same change replayed onto a moved base keeps its footprint.
 */
export function parseDiffFootprints(diff: string): Map<string, DiffFile> {
  const files = new Map<string, DiffFile>();
  for (const section of diff.split(/^diff --git /m).slice(1)) {
    const lines = section.split("\n");
    const header = pathsFromDiffHeader(`diff --git ${lines[0] ?? ""}`);
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    const kept: string[] = [];
    let inHunk = false;
    for (const line of lines.slice(1)) {
      if (!inHunk) {
        if (line.startsWith("--- ")) {
          oldPath = normalizePatchPath(line.slice(4)) ?? undefined;
          continue;
        }
        if (line.startsWith("+++ ")) {
          newPath = normalizePatchPath(line.slice(4)) ?? undefined;
          continue;
        }
        if (line.startsWith("rename from ")) {
          renameFrom = normalizePatchPath(line.slice(12)) ?? undefined;
        }
        if (line.startsWith("rename to ")) {
          renameTo = normalizePatchPath(line.slice(10)) ?? undefined;
        }
        if (
          /^(new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to)/.test(
            line,
          )
        ) {
          kept.push(line);
        }
        if (line.startsWith("Binary files")) kept.push(line);
      }
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      if (inHunk && (line.startsWith("+") || line.startsWith("-"))) {
        kept.push(line);
      }
    }
    // A header-only section (mode change, rename without edits) names its
    // paths on the first line only.
    const path =
      renameTo ?? newPath ?? oldPath ?? header.newPath ?? header.oldPath;
    if (!path) continue;
    const previousPath = renameFrom;
    if (kept.some((line) => line.startsWith("Binary files"))) {
      // A binary change has no hunks, so its blob ids are its content.
      const index = lines.find((line) => line.startsWith("index "));
      if (index) kept.push(index.split(" ")[1] ?? "");
    }
    files.set(path, {
      path,
      ...(previousPath ? { previousPath } : {}),
      footprint: createHash("sha256").update(kept.join("\n")).digest("hex"),
    });
  }
  return files;
}

/**
 * The paths whose own change differs between the prior head and this one,
 * and those whose own change is the same but which the base changed between
 * the two merge bases: the same lines then land in different code.
 */
export function changedOwnPaths(
  prior: Map<string, DiffFile>,
  current: Map<string, DiffFile>,
  upstreamPaths: ReadonlySet<string> = new Set(),
): Array<{
  path: string;
  previousPath?: string;
  change: PrRiskFocusPath["change"];
}> {
  const changed: Array<{
    path: string;
    previousPath?: string;
    change: PrRiskFocusPath["change"];
  }> = [];
  for (const [path, file] of current) {
    const before = prior.get(path);
    if (!before) {
      changed.push({
        path,
        ...(file.previousPath ? { previousPath: file.previousPath } : {}),
        change: "added_to_pr",
      });
    } else if (before.footprint !== file.footprint) {
      changed.push({ path, change: "changed" });
    } else if (
      upstreamPaths.has(path) ||
      (file.previousPath !== undefined && upstreamPaths.has(file.previousPath))
    ) {
      changed.push({ path, change: "base_changed" });
    }
  }
  for (const path of prior.keys()) {
    if (!current.has(path)) changed.push({ path, change: "removed_from_pr" });
  }
  return changed.sort((left, right) => left.path.localeCompare(right.path));
}

/** Per-path symbols and contract lines named by an inter-diff. */
export function scanInterdiff(
  interdiff: string,
): Map<string, { symbols: string[]; contractLines: number; lines: number }> {
  const scanned = new Map<
    string,
    { symbols: string[]; contractLines: number; lines: number }
  >();
  for (const section of interdiff.split(/^diff --git /m).slice(1)) {
    const lines = section.split("\n");
    const header = pathsFromDiffHeader(`diff --git ${lines[0] ?? ""}`);
    const plus = lines.find((line) => line.startsWith("+++ "));
    const path =
      (plus === undefined ? null : normalizePatchPath(plus.slice(4))) ??
      header.newPath ??
      header.oldPath;
    if (!path) continue;
    const symbols = new Set<string>();
    let contractLines = 0;
    let changedLines = 0;
    for (const line of lines.slice(1)) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("@@")) {
        const context = HUNK_CONTEXT.exec(line)?.[1];
        if (context) symbols.add(context);
        continue;
      }
      if (!line.startsWith("+") && !line.startsWith("-")) continue;
      changedLines++;
      const declared = DECLARATION.exec(line)?.[1];
      if (declared) symbols.add(declared);
      if (EXPORT_LINE.test(line) || SIGNATURE_LINE.test(line)) contractLines++;
    }
    scanned.set(path, {
      symbols: [...symbols].slice(0, MAX_SYMBOLS_PER_PATH),
      contractLines,
      lines: changedLines,
    });
  }
  return scanned;
}

/**
 * The module path a source file is imported by, without its extension:
 * `src/a/b.ts` is `src/a/b`, and `src/a/index.ts` is `src/a`.
 */
export function importStem(path: string): string | null {
  if (!SOURCE_EXTENSION.test(path)) return null;
  const segments = path.replace(SOURCE_EXTENSION, "").split("/");
  if (segments.length > 1 && segments.at(-1) === "index") segments.pop();
  return segments.join("/") || null;
}

/**
 * Whether an import specifier in `importer` names the module at `stem`. A
 * relative specifier is resolved against the importer; any other (a package
 * alias such as `@/features/x`) must end in the module's last two path
 * segments, so a common file name does not match half the repository.
 */
export function importsModule(
  importer: string,
  specifier: string,
  stem: string,
): boolean {
  const bare = specifier.replace(/\.[cm]?[jt]sx?$/, "").replace(/\/index$/, "");
  if (bare.startsWith(".")) {
    const resolved = posix.normalize(posix.join(posix.dirname(importer), bare));
    return resolved === stem || resolved === `${stem}/index`;
  }
  const tail = stem.split("/").slice(-2).join("/");
  return bare === tail || bare.endsWith(`/${tail}`);
}

/** Whether a prior verdict's text names a path, by full path or file name. */
export function namedInPrior(
  path: string,
  prior: RiskIncremental["prior"],
): boolean {
  const text = `${prior.brief}\n${prior.details}`;
  const name = path.split("/").at(-1) ?? path;
  return text.includes(path) || (name.length >= 6 && text.includes(name));
}

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/** Assembles the focus list from what the evidence builder gathered. */
export function buildFocus(input: {
  priorHeadSha: string;
  baseMoved: boolean;
  changed: ReturnType<typeof changedOwnPaths>;
  upstreamPaths: ReadonlySet<string>;
  scanned: ReturnType<typeof scanInterdiff>;
  importers: ReadonlyMap<string, readonly string[]>;
  siblingTests: readonly string[];
  prior: RiskIncremental["prior"];
}): PrRiskFocus {
  const paths = input.changed.map<PrRiskFocusPath>((entry) => {
    const scan = input.scanned.get(entry.path);
    return {
      path: entry.path,
      change: entry.change,
      upstreamTouched:
        input.upstreamPaths.has(entry.path) ||
        (entry.previousPath !== undefined &&
          input.upstreamPaths.has(entry.previousPath)),
      symbols: scan?.symbols ?? [],
      contractLines: scan?.contractLines ?? 0,
      importers: [...(input.importers.get(entry.path) ?? [])].slice(
        0,
        MAX_IMPORTERS_PER_PATH,
      ),
      namedInPrior: namedInPrior(entry.path, input.prior),
    };
  });
  const tests = new Set<string>();
  for (const entry of paths) {
    if (entry.change !== "removed_from_pr" && isTestPath(entry.path)) {
      tests.add(entry.path);
    }
    for (const importer of entry.importers) {
      if (isTestPath(importer)) tests.add(importer);
    }
  }
  for (const test of input.siblingTests) tests.add(test);
  let interdiffLines = 0;
  for (const scan of input.scanned.values()) interdiffLines += scan.lines;
  return {
    priorHeadSha: input.priorHeadSha,
    baseMoved: input.baseMoved,
    paths,
    testsToRerun: [...tests].sort().slice(0, MAX_TESTS),
    totals: {
      paths: paths.length,
      interdiffLines,
      contractLines: paths.reduce(
        (total, entry) => total + entry.contractLines,
        0,
      ),
    },
  };
}
