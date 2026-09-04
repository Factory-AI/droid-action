/**
 * Line index shared by deterministic review-posting steps.
 *
 * Each hunk line is addressable from the new-file side, old-file side, or
 * both. Platform adapters use this to avoid sending anchors that their API
 * cannot resolve.
 */
export type FileLineIndex = {
  /** New-file line number -> "added", or the old line it pairs with. */
  newLines: Map<number, number | "added">;
  /** Old-file line number -> "removed", or the new line it pairs with. */
  oldLines: Map<number, number | "removed">;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

type DiffLineState = {
  index: FileLineIndex;
  oldLine: number;
  newLine: number;
  inHunk: boolean;
};

function createDiffLineState(): DiffLineState {
  return {
    index: { newLines: new Map(), oldLines: new Map() },
    oldLine: 0,
    newLine: 0,
    inHunk: false,
  };
}

function indexDiffLine(state: DiffLineState, raw: string): void {
  const hunk = HUNK_HEADER.exec(raw);
  if (hunk) {
    state.oldLine = Number(hunk[1]);
    state.newLine = Number(hunk[2]);
    state.inHunk = true;
    return;
  }
  if (!state.inHunk || raw.startsWith("\\")) return;

  if (raw.startsWith("+")) {
    state.index.newLines.set(state.newLine, "added");
    state.newLine += 1;
  } else if (raw.startsWith("-")) {
    state.index.oldLines.set(state.oldLine, "removed");
    state.oldLine += 1;
  } else {
    // Context lines normally start with a space. Treat an empty line as
    // context too because some artifact producers strip the prefix.
    state.index.newLines.set(state.newLine, state.oldLine);
    state.index.oldLines.set(state.oldLine, state.newLine);
    state.newLine += 1;
    state.oldLine += 1;
  }
}

/** Indexes the hunks for one file diff. */
export function buildFileLineIndex(diff: string): FileLineIndex {
  const state = createDiffLineState();

  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();

  for (const raw of lines) {
    indexDiffLine(state, raw);
  }

  return state.index;
}

function decodeGitQuotedPath(value: string): string {
  const bytes: number[] = [];

  for (let i = 0; i < value.length; i += 1) {
    const current = value[i]!;
    if (current !== "\\") {
      bytes.push(...Buffer.from(current));
      continue;
    }

    const next = value[i + 1];
    if (next === undefined) {
      bytes.push("\\".charCodeAt(0));
      continue;
    }

    const octal = value.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      i += octal.length;
      continue;
    }

    const escapes: Record<string, string> = {
      a: "\x07",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      '"': '"',
    };
    bytes.push(...Buffer.from(escapes[next] ?? next));
    i += 1;
  }

  return Buffer.from(bytes).toString("utf8");
}

function normalizePatchPath(raw: string): string | null {
  let value = raw.replace(/\r$/, "");

  if (value.startsWith('"')) {
    let escaped = false;
    let closingQuote = -1;
    for (let i = 1; i < value.length; i += 1) {
      const current = value[i]!;
      if (current === '"' && !escaped) {
        closingQuote = i;
        break;
      }
      escaped = current === "\\" && !escaped;
      if (current !== "\\") escaped = false;
    }
    if (closingQuote > 0) {
      value = decodeGitQuotedPath(value.slice(1, closingQuote));
    }
  } else {
    value = value.split("\t", 1)[0]!;
  }

  if (value === "/dev/null") return null;
  return value.startsWith("a/") || value.startsWith("b/")
    ? value.slice(2)
    : value;
}

function pathsFromDiffHeader(line: string): {
  oldPath: string | null;
  newPath: string | null;
} {
  const value = line.slice("diff --git ".length);
  if (value.startsWith('"')) {
    // Quoted headers can contain spaces and escapes. The authoritative
    // `---`/`+++` lines below carry the same paths and are easier to parse.
    return { oldPath: null, newPath: null };
  }

  const separator = value.lastIndexOf(" b/");
  if (separator < 0) return { oldPath: null, newPath: null };
  return {
    oldPath: normalizePatchPath(value.slice(0, separator)),
    newPath: normalizePatchPath(value.slice(separator + 1)),
  };
}

/**
 * Splits a combined `git diff`/`gh pr diff` artifact and indexes each file.
 * Renames are registered under both the old and new paths.
 */
export function buildUnifiedDiffIndex(
  diff: string,
): Map<string, FileLineIndex> {
  const files = new Map<string, FileLineIndex>();
  let current:
    | {
        oldPath: string | null;
        newPath: string | null;
        state: DiffLineState;
      }
    | undefined;

  const flush = (): void => {
    if (!current) return;
    if (current.newPath) files.set(current.newPath, current.state.index);
    if (current.oldPath && current.oldPath !== current.newPath) {
      files.set(current.oldPath, current.state.index);
    }
  };

  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      flush();
      current = {
        ...pathsFromDiffHeader(raw),
        state: createDiffLineState(),
      };
      continue;
    }
    if (!current) continue;

    if (!current.state.inHunk && raw.startsWith("--- ")) {
      current.oldPath = normalizePatchPath(raw.slice(4));
    } else if (!current.state.inHunk && raw.startsWith("+++ ")) {
      current.newPath = normalizePatchPath(raw.slice(4));
    }

    indexDiffLine(current.state, raw);
  }
  flush();

  return files;
}
