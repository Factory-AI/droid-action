import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { collectDebugArtifacts } from "../../src/utils/debug-artifacts";
import {
  GITHUB_CREDENTIAL_ENV_NAMES,
  GITLAB_CREDENTIAL_ENV_NAMES,
  REDACTED,
  redactSecrets,
  secretValuesFromEnv,
} from "../../src/utils/redact-credentials";
import { githubDebugArtifactSources } from "../../src/entrypoints/collect-debug-artifacts";
import { gitlabDebugArtifactSources } from "../../src/entrypoints/gitlab-collect-debug-artifacts";

const repoRoot = path.join(import.meta.dir, "..", "..");

// Fake credentials. Exact-value redaction runs before the format patterns, so
// even values a pattern would catch come out as the plain REDACTED marker.
const APP_TOKEN = `ghs_${"a1B2c3D4e5".repeat(5)}.${"x9Y8z7".repeat(4)}`;
const WORKFLOW_TOKEN = `ghs_${"Q7w8E9r0T1".repeat(4)}`;
const FACTORY_API_KEY = "fk-test-0123456789abcdefABCDEF";
const GITLAB_TOKEN = ["glpat", "Zq7Xp2Lm9K0a1b2c3d4e"].join("-");
const ALL_SECRETS = [APP_TOKEN, WORKFLOW_TOKEN, FACTORY_API_KEY, GITLAB_TOKEN];

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "droid-debug-artifacts-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function write(file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Every entry under dir, symlinks included, as sorted relative paths. */
function listEntries(dir: string): string[] {
  const entries: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (lstatSync(full).isDirectory()) {
        walk(full);
      } else {
        entries.push(path.relative(dir, full));
      }
    }
  };
  walk(dir);
  return entries.sort();
}

function expectNoSecrets(dir: string): void {
  for (const entry of listEntries(dir)) {
    const content = readFileSync(path.join(dir, entry), "latin1");
    for (const secret of ALL_SECRETS) {
      expect(content).not.toContain(secret);
    }
  }
}

/**
 * Lays out a runner the way a review run leaves it: `droid mcp add` has
 * written the App token into ~/.factory/mcp.json, and the session transcript
 * and prompts directory contain credentials Droid printed.
 */
function createRunner(): { home: string; runnerTemp: string } {
  const home = path.join(sandbox, "home");
  const runnerTemp = path.join(sandbox, "runner-temp");
  const factory = path.join(home, ".factory");
  const prompts = path.join(runnerTemp, "droid-prompts");

  write(
    path.join(factory, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        github_comment: {
          type: "stdio",
          command: "bun",
          args: ["run", "/action/src/mcp/github-comment-server.ts"],
          env: { GITHUB_TOKEN: APP_TOKEN, REPO_OWNER: "o", REPO_NAME: "r" },
        },
        github_ci: { env: { GITHUB_TOKEN: WORKFLOW_TOKEN } },
      },
    }),
  );
  write(path.join(factory, "settings.json"), `{"apiKey":"${FACTORY_API_KEY}"}`);
  write(path.join(factory, "droids", "security-reviewer.md"), "# droid\n");
  write(
    path.join(factory, "logs", "droid-log-single.log"),
    `request Authorization: Bearer ${APP_TOKEN}\nok\n`,
  );
  write(
    path.join(factory, "sessions", "-home-runner-work", "abc.jsonl"),
    `{"tool":"Execute","output":"GITHUB_TOKEN=${APP_TOKEN}\\nFACTORY_API_KEY=${FACTORY_API_KEY}"}\n`,
  );
  write(
    path.join(factory, "sessions", "mcp.json"),
    `{"env":{"GITHUB_TOKEN":"${APP_TOKEN}"}}`,
  );

  write(path.join(prompts, "pr.diff"), "diff --git a/x b/x\n+hello\n");
  write(
    path.join(prompts, "review_candidates.json"),
    `{"comments":[{"body":"token ${WORKFLOW_TOKEN}"}]}`,
  );
  write(
    path.join(prompts, "binary.bin"),
    Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x00, 0x80]),
      Buffer.from(FACTORY_API_KEY, "latin1"),
      Buffer.from([0xc3]),
    ]),
  );
  symlinkSync(path.join(factory, "mcp.json"), path.join(prompts, "leak.json"));
  symlinkSync(factory, path.join(prompts, "factory-link"));

  return { home, runnerTemp };
}

const runnerEnv = {
  GITHUB_TOKEN: APP_TOKEN,
  DEFAULT_WORKFLOW_TOKEN: WORKFLOW_TOKEN,
  FACTORY_API_KEY,
};

describe("redactSecrets", () => {
  it("replaces every occurrence of each secret", () => {
    expect(
      redactSecrets(`a ${FACTORY_API_KEY} b ${FACTORY_API_KEY}`, [
        FACTORY_API_KEY,
      ]),
    ).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  it("redacts GitHub tokens it was not given", () => {
    expect(redactSecrets(`t=${APP_TOKEN}`, [])).toBe(
      "t=[REDACTED_GITHUB_TOKEN]",
    );
  });

  it("ignores values too short to be credentials", () => {
    expect(redactSecrets("true false 1234567", ["true", "1234567"])).toBe(
      "true false 1234567",
    );
  });
});

describe("secretValuesFromEnv", () => {
  it("trims, drops short or missing values, dedupes, and sorts longest first", () => {
    const values = secretValuesFromEnv(["A", "B", "C", "D", "E"], {
      A: "abcdefgh",
      B: "  abcdefghijkl ",
      C: "short",
      E: "abcdefgh",
    });
    expect(values).toEqual(["abcdefghijkl", "abcdefgh"]);
    // Longest first, so a secret containing another is redacted whole.
    expect(redactSecrets("abcdefghijkl", values)).toBe(REDACTED);
  });
});

describe("collectDebugArtifacts with the GitHub layout", () => {
  it("stages only logs, sessions and prompts, without mcp.json, symlinks or secrets", async () => {
    const { home, runnerTemp } = createRunner();
    const outputDir = path.join(runnerTemp, "droid-debug-artifacts");

    const result = await collectDebugArtifacts({
      sources: githubDebugArtifactSources(home, runnerTemp),
      outputDir,
      secrets: secretValuesFromEnv(GITHUB_CREDENTIAL_ENV_NAMES, runnerEnv),
    });

    expect(listEntries(outputDir)).toEqual([
      "droid-prompts/binary.bin",
      "droid-prompts/pr.diff",
      "droid-prompts/review_candidates.json",
      "factory/logs/droid-log-single.log",
      "factory/sessions/-home-runner-work/abc.jsonl",
    ]);
    expect(result.files).toBe(5);
    expect(result.skipped).toHaveLength(3);
    expectNoSecrets(outputDir);

    expect(
      readFileSync(path.join(outputDir, "droid-prompts/pr.diff"), "utf8"),
    ).toBe("diff --git a/x b/x\n+hello\n");
    expect(
      readFileSync(
        path.join(outputDir, "factory/sessions/-home-runner-work/abc.jsonl"),
        "utf8",
      ),
    ).toBe(
      `{"tool":"Execute","output":"GITHUB_TOKEN=${REDACTED}\\nFACTORY_API_KEY=${REDACTED}"}\n`,
    );
    expect(
      readFileSync(path.join(outputDir, "droid-prompts/binary.bin")),
    ).toEqual(
      Buffer.concat([
        Buffer.from([0xff, 0xfe, 0x00, 0x80]),
        Buffer.from(REDACTED, "latin1"),
        Buffer.from([0xc3]),
      ]),
    );
  });

  it("replaces a symlink planted at the output directory without writing through it", async () => {
    const { home, runnerTemp } = createRunner();
    const target = path.join(sandbox, "elsewhere");
    write(path.join(target, "keep.txt"), "keep");
    const outputDir = path.join(runnerTemp, "droid-debug-artifacts");
    symlinkSync(target, outputDir);

    await collectDebugArtifacts({
      sources: githubDebugArtifactSources(home, runnerTemp),
      outputDir,
      secrets: [],
    });

    expect(lstatSync(outputDir).isDirectory()).toBe(true);
    expect(listEntries(target)).toEqual(["keep.txt"]);
  });

  it("clears what an earlier run left in the output directory", async () => {
    const { home, runnerTemp } = createRunner();
    const outputDir = path.join(runnerTemp, "droid-debug-artifacts");
    write(path.join(outputDir, ".factory", "mcp.json"), APP_TOKEN);

    await collectDebugArtifacts({
      sources: githubDebugArtifactSources(home, runnerTemp),
      outputDir,
      secrets: [],
    });

    expect(existsSync(path.join(outputDir, ".factory"))).toBe(false);
  });

  it("stages nothing when the sources do not exist", async () => {
    const outputDir = path.join(sandbox, "out");
    const result = await collectDebugArtifacts({
      sources: githubDebugArtifactSources(
        path.join(sandbox, "no-home"),
        path.join(sandbox, "no-temp"),
      ),
      outputDir,
      secrets: [],
    });
    expect(result.files).toBe(0);
    expect(listEntries(outputDir)).toEqual([]);
  });

  // Root can read a mode-000 file, so the failure cannot be provoked there.
  it.skipIf(process.getuid?.() === 0)(
    "removes the output directory when a file cannot be read",
    async () => {
      const { home, runnerTemp } = createRunner();
      const unreadable = path.join(
        home,
        ".factory",
        "sessions",
        "unreadable.jsonl",
      );
      write(unreadable, "x");
      chmodSync(unreadable, 0o000);
      const outputDir = path.join(runnerTemp, "droid-debug-artifacts");

      await expect(
        collectDebugArtifacts({
          sources: githubDebugArtifactSources(home, runnerTemp),
          outputDir,
          secrets: [],
        }),
      ).rejects.toThrow();
      expect(existsSync(outputDir)).toBe(false);
      chmodSync(unreadable, 0o600);
    },
  );
});

describe("collectDebugArtifacts with the GitLab layout", () => {
  it("redacts the job's credentials from the pass logs", async () => {
    const prompts = path.join(sandbox, "droid-prompts");
    write(
      path.join(prompts, "pass1-output.jsonl"),
      `{"output":"GITLAB_TOKEN=${GITLAB_TOKEN} FACTORY_API_KEY=${FACTORY_API_KEY}"}\n`,
    );
    const outputDir = path.join(sandbox, "project", ".droid-debug");

    await collectDebugArtifacts({
      sources: gitlabDebugArtifactSources(prompts),
      outputDir,
      secrets: secretValuesFromEnv(GITLAB_CREDENTIAL_ENV_NAMES, {
        GITLAB_TOKEN,
        FACTORY_API_KEY,
      }),
    });

    expect(
      readFileSync(
        path.join(outputDir, "prompts", "pass1-output.jsonl"),
        "utf8",
      ),
    ).toBe(
      `{"output":"GITLAB_TOKEN=${REDACTED} FACTORY_API_KEY=${REDACTED}"}\n`,
    );
  });
});

// Runs the entrypoints the way the workflow steps do, so the env wiring and
// the default paths are exercised too.
describe("debug artifact entrypoints", () => {
  const runEntrypoint = (script: string, env: Record<string, string>) =>
    Bun.spawnSync({
      cmd: [process.execPath, "run", path.join(repoRoot, script)],
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });

  it("stages a redacted GitHub artifact without mcp.json", () => {
    const { home, runnerTemp } = createRunner();
    const outputDir = path.join(runnerTemp, "droid-debug-artifacts");

    const proc = runEntrypoint("src/entrypoints/collect-debug-artifacts.ts", {
      HOME: home,
      RUNNER_TEMP: runnerTemp,
      DEBUG_ARTIFACTS_DIR: outputDir,
      ...runnerEnv,
    });

    expect(proc.exitCode).toBe(0);
    const entries = listEntries(outputDir);
    expect(entries).toContain("factory/sessions/-home-runner-work/abc.jsonl");
    expect(entries.some((entry) => entry.endsWith("mcp.json"))).toBe(false);
    expect(entries.some((entry) => entry.includes("settings.json"))).toBe(
      false,
    );
    expectNoSecrets(outputDir);
  });

  it("stages a redacted GitLab artifact", () => {
    const prompts = path.join(sandbox, "droid-prompts");
    write(
      path.join(prompts, "pass2-output.jsonl"),
      `{"output":"${GITLAB_TOKEN} ${FACTORY_API_KEY}"}\n`,
    );
    const projectDir = path.join(sandbox, "project");
    mkdirSync(projectDir);

    const proc = runEntrypoint(
      "src/entrypoints/gitlab-collect-debug-artifacts.ts",
      {
        CI_PROJECT_DIR: projectDir,
        DROID_PROMPT_FILE: path.join(prompts, "droid-prompt.txt"),
        GITLAB_TOKEN,
        FACTORY_API_KEY,
      },
    );

    expect(proc.exitCode).toBe(0);
    const outputDir = path.join(projectDir, ".droid-debug");
    expect(listEntries(outputDir)).toContain("prompts/pass2-output.jsonl");
    expectNoSecrets(outputDir);
  });
});
