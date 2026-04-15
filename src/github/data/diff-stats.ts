import { execSync } from "child_process";
import type { DiffStats } from "../../utils/diff-risk";

const LOCKFILE_PATTERNS = [
  "package-lock.json",
  "bun.lock",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Gemfile.lock",
  "Pipfile.lock",
  "poetry.lock",
  "go.sum",
  "Cargo.lock",
];

const CONFIG_PATTERNS = [
  /tsconfig.*\.json$/,
  /\.eslintrc/,
  /prettier/,
  /jest\.config/,
  /vitest\.config/,
  /webpack\.config/,
  /vite\.config/,
  /\.babelrc/,
  /rollup\.config/,
];

const MIGRATION_PATTERNS = [
  /migrations?\//,
  /migrate/,
  /schema\.(ts|js|sql|prisma)$/,
  /\.sql$/,
];

export function isRenamedFile(line: string): boolean {
  return line.includes("{") && line.includes("=>");
}

export async function computeDiffStats(
  baseRef: string,
  headRef?: string,
): Promise<DiffStats> {
  const target = headRef || "HEAD";

  let mergeBase: string;
  try {
    mergeBase = execSync(
      `git merge-base ${target} refs/remotes/origin/${baseRef}`,
      { encoding: "utf8", stdio: "pipe" },
    ).trim();
  } catch {
    mergeBase = `refs/remotes/origin/${baseRef}`;
  }

  const diffStatOutput = execSync(
    `git diff --numstat ${mergeBase}..${target}`,
    { encoding: "utf8", stdio: "pipe", maxBuffer: 50 * 1024 * 1024 },
  );

  const changedFiles: string[] = [];
  let additions = 0;
  let deletions = 0;

  const lines = diffStatOutput.trim().split("\n").filter(Boolean);

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;

    const added = parts[0]!;
    const filePath = parts[2]!;

    additions += added === "-" ? 0 : parseInt(added, 10);
    deletions += added === "-" ? 0 : parseInt(added, 10);
    changedFiles.push(filePath);
  }

  const hasLockfileChanges = changedFiles.some((file) => {
    const fileName = file.split("/").pop() || "";
    return LOCKFILE_PATTERNS.includes(fileName);
  });

  const hasConfigChanges = changedFiles.some((file) =>
    CONFIG_PATTERNS.some((pattern) => pattern.test(file)),
  );

  const hasMigrationChanges = changedFiles.some((file) =>
    MIGRATION_PATTERNS.some((pattern) => pattern.test(file)),
  );

  return {
    totalFiles: changedFiles.length,
    additions,
    deletions,
    changedFiles,
    hasLockfileChanges,
    hasConfigChanges,
    hasMigrationChanges,
  };
}

export function parseDiffStatsFromRawDiff(rawDiff: string): DiffStats {
  const fileHeaderPattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  const addLinePattern = /^\+[^+]/gm;
  const deleteLinePattern = /^-[^-]/gm;

  const changedFiles: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = fileHeaderPattern.exec(rawDiff)) !== null) {
    changedFiles.push(match[2]!);
  }

  const diffSections = rawDiff.split(/^diff --git /m).filter(Boolean);
  let additions = 0;
  let deletions = 0;

  for (let i = 0; i < diffSections.length; i++) {
    const section = diffSections[i]!;
    const sectionAdds = (section.match(addLinePattern) || []).length;
    const sectionDels = (section.match(deleteLinePattern) || []).length;
    additions += sectionAdds;
    deletions += sectionDels;
  }

  const hasLockfileChanges = changedFiles.some((file) => {
    const fileName = file.split("/").pop() || "";
    return LOCKFILE_PATTERNS.includes(fileName);
  });

  const hasConfigChanges = changedFiles.some((file) =>
    CONFIG_PATTERNS.some((pattern) => pattern.test(file)),
  );

  const hasMigrationChanges = changedFiles.some((file) =>
    MIGRATION_PATTERNS.some((pattern) => pattern.test(file)),
  );

  return {
    totalFiles: changedFiles.length,
    additions,
    deletions,
    changedFiles,
    hasLockfileChanges,
    hasConfigChanges,
    hasMigrationChanges,
  };
}
