import {
  mkdir,
  lstat,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { redactFileText } from "./redact";

export type DebugArtifactMode = "none" | "redacted";

export interface PrepareDebugArtifactsOptions {
  mode: DebugArtifactMode;
  outputDir: string;
  factoryHome: string;
  droidPromptsDir: string;
}

export interface PreparedDebugArtifacts {
  prepared: boolean;
  files: string[];
}

interface AllowlistedFile {
  sourcePath: string;
  outputPath: string;
}

const PROMPT_FILES = [
  "droid-prompt.txt",
  "pr.diff",
  "existing_comments.json",
  "pr_description.txt",
  "review_candidates.json",
  "review_validated.json",
];

const FACTORY_ROOT_FILES = ["settings.json", "settings.local.json", "mcp.json"];
const MAX_RECURSIVE_FILES = 200;
const MAX_RECURSIVE_DEPTH = 5;

function isEnoent(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory();
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }

    throw error;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile();
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }

    throw error;
  }
}

async function listFilesRecursive(
  dir: string,
  files: string[] = [],
  depth = 0,
): Promise<string[]> {
  if (!(await isDirectory(dir))) return [];
  if (depth > MAX_RECURSIVE_DEPTH || files.length >= MAX_RECURSIVE_FILES) {
    return files;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;

    const entryPath = join(dir, entry.name);
    if (entry.isFile()) {
      files.push(entryPath);
      if (files.length >= MAX_RECURSIVE_FILES) break;
      continue;
    }

    if (entry.isDirectory()) {
      await listFilesRecursive(entryPath, files, depth + 1);
    }
  }

  return files;
}

function outputWithRedactedSuffix(
  outputDir: string,
  ...parts: string[]
): string {
  const leaf = parts.at(-1);
  if (!leaf) throw new Error("Cannot prepare output path without a filename");

  return join(outputDir, ...parts.slice(0, -1), `${leaf}.redacted`);
}

function relativePathParts(root: string, path: string): string[] {
  return relative(root, path).split(/[\\/]/).filter(Boolean);
}

async function buildAllowlist(
  options: PrepareDebugArtifactsOptions,
): Promise<AllowlistedFile[]> {
  const promptFiles = PROMPT_FILES.map((file) => ({
    sourcePath: join(options.droidPromptsDir, file),
    outputPath: outputWithRedactedSuffix(options.outputDir, "prompts", file),
  }));

  const factoryRootFiles = FACTORY_ROOT_FILES.map((file) => ({
    sourcePath: join(options.factoryHome, file),
    outputPath: outputWithRedactedSuffix(options.outputDir, "factory", file),
  }));

  const factoryDroidFiles = [
    {
      sourcePath: join(options.factoryHome, "droid", "settings.json"),
      outputPath: outputWithRedactedSuffix(
        options.outputDir,
        "factory",
        "droid",
        "settings.json",
      ),
    },
  ];

  const logsRoot = join(options.factoryHome, "logs");
  const logFiles = (await listFilesRecursive(logsRoot)).map((file) => ({
    sourcePath: file,
    outputPath: outputWithRedactedSuffix(
      options.outputDir,
      "factory",
      "logs",
      ...relativePathParts(logsRoot, file),
    ),
  }));

  const sessionsRoot = join(options.factoryHome, "sessions");
  const sessionFiles = (await listFilesRecursive(sessionsRoot)).map((file) => ({
    sourcePath: file,
    outputPath: outputWithRedactedSuffix(
      options.outputDir,
      "factory",
      "sessions",
      ...relativePathParts(sessionsRoot, file),
    ),
  }));

  return [
    ...promptFiles,
    ...factoryRootFiles,
    ...factoryDroidFiles,
    ...logFiles,
    ...sessionFiles,
  ];
}

export async function prepareDebugArtifacts(
  options: PrepareDebugArtifactsOptions,
): Promise<PreparedDebugArtifacts> {
  if (options.mode === "none") {
    return { prepared: false, files: [] };
  }

  await rm(options.outputDir, { recursive: true, force: true });
  await mkdir(options.outputDir, { recursive: true });

  const allowlist = await buildAllowlist(options);
  const files: string[] = [];

  for (const file of allowlist) {
    if (!(await isRegularFile(file.sourcePath))) continue;

    const input = await readFile(file.sourcePath, "utf8");
    const redacted = redactFileText(file.sourcePath, input);

    await mkdir(dirname(file.outputPath), { recursive: true });
    await writeFile(file.outputPath, redacted);
    files.push(file.outputPath);
  }

  const manifestPath = join(options.outputDir, "manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        mode: "redacted",
        files: files
          .map((file) => relative(options.outputDir, file).replace(/\\/g, "/"))
          .sort(),
      },
      null,
      2,
    )}\n`,
  );
  files.push(manifestPath);

  return { prepared: true, files };
}
