import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDebugArtifacts } from "../../src/debug-artifacts/collect";

const tempRoots: string[] = [];

function fakeGitHubActionsToken(): string {
  return ["ghs", "_", "a".repeat(36)].join("");
}

function fakeGitHubPat(): string {
  return ["github", "pat", "test", "fake", "token"].join("_");
}

function fakeBearerHeader(): string {
  return ["Bearer", ["test", "bearer", "token"].join("-")].join(" ");
}

async function makeTempRoot() {
  const root = await mkdtemp(join(tmpdir(), "droid-debug-artifacts-test-"));
  tempRoots.push(root);
  return root;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("prepareDebugArtifacts", () => {
  it("debug_artifacts=none prepares no bundle", async () => {
    const root = await makeTempRoot();
    const outputDir = join(root, "out");

    const result = await prepareDebugArtifacts({
      mode: "none",
      outputDir,
      factoryHome: join(root, ".factory"),
      droidPromptsDir: join(root, "droid-prompts"),
    });

    expect(result.prepared).toBe(false);
    expect(result.files).toEqual([]);
    expect(await exists(outputDir)).toBe(false);
  });

  it("debug_artifacts=redacted prepares only allowlisted redacted files", async () => {
    const root = await makeTempRoot();
    const factoryHome = join(root, ".factory");
    const promptsDir = join(root, "droid-prompts");
    const outputDir = join(root, "out");
    const githubActionsToken = fakeGitHubActionsToken();
    const githubPatToken = fakeGitHubPat();
    const bearerHeader = fakeBearerHeader();
    const bearerValue = bearerHeader.replace("Bearer ", "");

    await mkdir(join(factoryHome, "droid"), { recursive: true });
    await mkdir(join(factoryHome, "logs"), { recursive: true });
    await mkdir(join(factoryHome, "logs", "nested"), { recursive: true });
    await mkdir(join(factoryHome, "sessions"), { recursive: true });
    await mkdir(join(factoryHome, "sessions", "nested"), { recursive: true });
    await mkdir(join(factoryHome, "cache"), { recursive: true });
    await mkdir(join(factoryHome, "plugins", "plugin-a"), { recursive: true });
    await mkdir(join(factoryHome, "bin"), { recursive: true });
    await mkdir(promptsDir, { recursive: true });

    await writeFile(
      join(factoryHome, "settings.json"),
      JSON.stringify({
        customModels: [{ apiKey: "custom-model-secret-test-value" }],
      }),
    );
    await writeFile(
      join(factoryHome, "settings.local.json"),
      JSON.stringify({ apiKey: "${CUSTOM_MODEL_API_KEY}" }),
    );
    await writeFile(
      join(factoryHome, "mcp.json"),
      JSON.stringify({
        env: { GITHUB_TOKEN: githubActionsToken },
      }),
    );
    await writeFile(
      join(factoryHome, "droid", "settings.json"),
      JSON.stringify({
        model: "test-model",
        token: githubPatToken,
      }),
    );
    await writeFile(
      join(factoryHome, "logs", "run.log"),
      `Authorization: ${bearerHeader}`,
    );
    await writeFile(
      join(factoryHome, "logs", "nested", "nested.log"),
      `nested Authorization: ${bearerHeader}`,
    );
    await writeFile(
      join(factoryHome, "sessions", "session.jsonl"),
      `${JSON.stringify({ accessToken: githubPatToken })}\n`,
    );
    await writeFile(
      join(factoryHome, "sessions", "nested", "session.jsonl"),
      `${JSON.stringify({ refreshToken: githubPatToken })}\n`,
    );
    await writeFile(join(factoryHome, "cache", "raw.txt"), "do-not-copy");
    await writeFile(
      join(factoryHome, "plugins", "plugin-a", "raw.txt"),
      "do-not-copy",
    );
    await writeFile(join(factoryHome, "bin", "droid"), "do-not-copy");
    await writeFile(
      join(promptsDir, "droid-prompt.txt"),
      "apiKey: custom-model-secret-test-value",
    );
    await writeFile(join(promptsDir, "pr.diff"), bearerHeader);
    await writeFile(join(promptsDir, "unknown.txt"), "do-not-copy");

    const result = await prepareDebugArtifacts({
      mode: "redacted",
      outputDir,
      factoryHome,
      droidPromptsDir: promptsDir,
    });

    expect(result.prepared).toBe(true);
    expect(await exists(join(outputDir, "manifest.json"))).toBe(true);
    expect(await exists(join(outputDir, "factory", "settings.json"))).toBe(
      false,
    );
    expect(
      await exists(join(outputDir, "factory", "settings.json.redacted")),
    ).toBe(true);
    expect(await exists(join(outputDir, "factory", "mcp.json"))).toBe(false);
    expect(await exists(join(outputDir, "factory", "mcp.json.redacted"))).toBe(
      true,
    );
    expect(await exists(join(outputDir, "factory", "cache"))).toBe(false);
    expect(await exists(join(outputDir, "factory", "plugins"))).toBe(false);
    expect(await exists(join(outputDir, "factory", "bin"))).toBe(false);
    expect(
      await exists(join(outputDir, "prompts", "unknown.txt.redacted")),
    ).toBe(false);

    const redactedSettings = await readFile(
      join(outputDir, "factory", "settings.json.redacted"),
      "utf8",
    );
    const redactedMcp = await readFile(
      join(outputDir, "factory", "mcp.json.redacted"),
      "utf8",
    );
    const redactedPrompt = await readFile(
      join(outputDir, "prompts", "droid-prompt.txt.redacted"),
      "utf8",
    );
    const redactedLog = await readFile(
      join(outputDir, "factory", "logs", "run.log.redacted"),
      "utf8",
    );
    const redactedNestedLog = await readFile(
      join(outputDir, "factory", "logs", "nested", "nested.log.redacted"),
      "utf8",
    );
    const redactedSession = await readFile(
      join(outputDir, "factory", "sessions", "session.jsonl.redacted"),
      "utf8",
    );
    const redactedNestedSession = await readFile(
      join(
        outputDir,
        "factory",
        "sessions",
        "nested",
        "session.jsonl.redacted",
      ),
      "utf8",
    );

    const combined = [
      redactedSettings,
      redactedMcp,
      redactedPrompt,
      redactedLog,
      redactedNestedLog,
      redactedSession,
      redactedNestedSession,
    ].join("\n");

    expect(combined).not.toContain("custom-model-secret-test-value");
    expect(combined).not.toContain(githubActionsToken);
    expect(combined).not.toContain(githubPatToken);
    expect(combined).not.toContain(bearerValue);

    const manifest = JSON.parse(
      await readFile(join(outputDir, "manifest.json"), "utf8"),
    ) as { files: string[] };
    expect(manifest.files).toContain("factory/logs/run.log.redacted");
    expect(manifest.files).toContain("factory/logs/nested/nested.log.redacted");
    expect(manifest.files).toContain(
      "factory/sessions/nested/session.jsonl.redacted",
    );
    expect(
      manifest.files.every(
        (file) => !file.startsWith("/") && !file.includes("\\"),
      ),
    ).toBe(true);
  });

  it("removes stale output files before preparing a redacted bundle", async () => {
    const root = await makeTempRoot();
    const factoryHome = join(root, ".factory");
    const promptsDir = join(root, "droid-prompts");
    const outputDir = join(root, "out");

    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "stale-secret.txt"), "do-not-keep");
    await mkdir(promptsDir, { recursive: true });
    await writeFile(join(promptsDir, "droid-prompt.txt"), "safe prompt");

    const result = await prepareDebugArtifacts({
      mode: "redacted",
      outputDir,
      factoryHome,
      droidPromptsDir: promptsDir,
    });

    expect(result.prepared).toBe(true);
    expect(await exists(join(outputDir, "stale-secret.txt"))).toBe(false);
    expect(await exists(join(outputDir, "manifest.json"))).toBe(true);
    expect(
      await exists(join(outputDir, "prompts", "droid-prompt.txt.redacted")),
    ).toBe(true);
  });

  it("skips direct allowlisted files that are symlinks", async () => {
    const root = await makeTempRoot();
    const factoryHome = join(root, ".factory");
    const promptsDir = join(root, "droid-prompts");
    const outputDir = join(root, "out");
    const outsideFile = join(root, "outside-settings.json");

    await mkdir(factoryHome, { recursive: true });
    await mkdir(promptsDir, { recursive: true });
    await writeFile(outsideFile, "custom-model-secret-test-value");

    try {
      await symlink(outsideFile, join(factoryHome, "settings.json"), "file");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        return;
      }

      throw error;
    }

    const result = await prepareDebugArtifacts({
      mode: "redacted",
      outputDir,
      factoryHome,
      droidPromptsDir: promptsDir,
    });

    expect(result.prepared).toBe(true);
    expect(
      await exists(join(outputDir, "factory", "settings.json.redacted")),
    ).toBe(false);
  });

  it("skips recursive allowlisted directories that are symlinks", async () => {
    const root = await makeTempRoot();
    const factoryHome = join(root, ".factory");
    const promptsDir = join(root, "droid-prompts");
    const outputDir = join(root, "out");
    const outsideLogs = join(root, "outside-logs");

    await mkdir(factoryHome, { recursive: true });
    await mkdir(promptsDir, { recursive: true });
    await mkdir(outsideLogs, { recursive: true });
    await writeFile(
      join(outsideLogs, "run.log"),
      "custom-model-secret-test-value",
    );

    try {
      await symlink(outsideLogs, join(factoryHome, "logs"), "dir");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        return;
      }

      throw error;
    }

    const result = await prepareDebugArtifacts({
      mode: "redacted",
      outputDir,
      factoryHome,
      droidPromptsDir: promptsDir,
    });

    expect(result.prepared).toBe(true);
    expect(
      await exists(join(outputDir, "factory", "logs", "run.log.redacted")),
    ).toBe(false);
  });
});
