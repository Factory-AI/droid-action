import { lstat, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import { redactSecrets } from "./redact-credentials";

// The droid CLI writes each MCP server's definition, including its env and so
// the GitHub token, to mcp.json.
const EXCLUDED_FILE_NAMES = new Set(["mcp.json"]);

export type DebugArtifactSource = {
  /** File or directory to copy. A missing source is skipped. */
  from: string;
  /** Destination, relative to the output directory. */
  to: string;
};

export type CollectDebugArtifactsOptions = {
  sources: readonly DebugArtifactSource[];
  outputDir: string;
  secrets: readonly string[];
};

export type CollectDebugArtifactsResult = {
  files: number;
  skipped: string[];
};

/**
 * Copies the sources into a fresh output directory with every known secret
 * redacted. Symlinks and credential files are skipped, not followed. On any
 * error the output directory is removed, so a caller that uploads it only
 * after success never publishes a partly redacted copy.
 */
export async function collectDebugArtifacts({
  sources,
  outputDir,
  secrets,
}: CollectDebugArtifactsOptions): Promise<CollectDebugArtifactsResult> {
  const result: CollectDebugArtifactsResult = { files: 0, skipped: [] };
  // rm does not follow a symlink, so a link planted at outputDir is replaced
  // rather than written through.
  await rm(outputDir, { recursive: true, force: true });
  try {
    await mkdir(outputDir, { recursive: true });
    for (const source of sources) {
      await copyRedacted(
        source.from,
        path.join(outputDir, source.to),
        secrets,
        result,
      );
    }
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
  return result;
}

async function copyRedacted(
  from: string,
  to: string,
  secrets: readonly string[],
  result: CollectDebugArtifactsResult,
): Promise<void> {
  let info;
  try {
    info = await lstat(from);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (info.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from)) {
      await copyRedacted(
        path.join(from, entry),
        path.join(to, entry),
        secrets,
        result,
      );
    }
    return;
  }

  // Droid can create files in the directories collected here, and a symlink
  // among them could point at a credential file anywhere on the runner.
  if (!info.isFile() || EXCLUDED_FILE_NAMES.has(path.basename(from))) {
    result.skipped.push(from);
    return;
  }

  await mkdir(path.dirname(to), { recursive: true });
  // latin1 maps each byte to one code unit, so non-UTF-8 files round-trip
  // unchanged while ASCII credentials are still matched.
  const content = (await readFile(from)).toString("latin1");
  await writeFile(to, Buffer.from(redactSecrets(content, secrets), "latin1"), {
    mode: 0o600,
  });
  result.files++;
}
