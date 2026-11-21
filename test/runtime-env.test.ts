import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createControlledRuntime } from "./helpers/controlled-runtime";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "droid-runtime-env-"));
const runtime = realpathSync(process.execPath);
const marker = "RUNTIME_ENV_RECEIPT:";
const values = {
  DROID_EXEC_RUN_TYPE: "droid-security-review",
  ALLOWED_TOOLS: "Read,LS\nfixture\r\n%value%",
  DISALLOWED_TOOLS: "WebSearch,FetchUrl",
};
let sequence = 0;
let controlledRuntime: Awaited<ReturnType<typeof createControlledRuntime>>;

function file(name: string, contents = ""): string {
  const path = join(temporary, `${sequence++}-${name}`);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return Object.fromEntries(Object.entries(value));
}

function strings(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record(value))) {
    if (typeof item !== "string") throw new Error("Expected a string value");
    result[key] = item;
  }
  return result;
}

function receipt(stdout: string): Record<string, string> {
  const line = stdout.split("\n").find((item) => item.startsWith(marker));
  if (!line) throw new Error("Missing child-process receipt");
  return strings(JSON.parse(line.slice(marker.length)));
}

function commandFile(path: string): Record<string, string> {
  const lines = readFileSync(path, "utf8").split("\n");
  const result: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const match = /^([^<]+)<<(.+)$/.exec(lines[i] || "");
    if (!match) continue;
    const end = lines.indexOf(match[2]!, i + 1);
    if (end < 0) throw new Error("Incomplete runner file command");
    result[match[1]!] = lines.slice(i + 1, end).join("\n");
    i = end;
  }
  return result;
}

const childSource = `
const mode = process.env.FIXTURE_MODE;
const values = JSON.parse(process.env.FIXTURE_VALUES);
let caught = "";
try {
  if (mode === "control") {
    const core = await import("@actions/core");
    for (const [name, value] of Object.entries(values)) core.exportVariable(name, value);
  } else if (mode === "run-type") {
    const { setDroidRunType } = await import(${JSON.stringify(join(root, "src/run-type.ts"))});
    setDroidRunType(values.DROID_EXEC_RUN_TYPE);
  } else if (mode === "prompt") {
    const { createPrompt } = await import(${JSON.stringify(join(root, "src/create-prompt/index.ts"))});
    await createPrompt({
      githubContext: {
        eventName: "pull_request", runId: "1", actor: "fixture-author",
        repository: { owner: "fixture", repo: "fixture", full_name: "fixture/fixture" },
        entityNumber: 1, isPR: true,
        inputs: { triggerPhrase: "@droid", automaticReview: false },
        payload: { pull_request: { number: 1, title: "Fixture", body: "", user: { login: "fixture-author" } } },
      },
      commentId: 1, baseBranch: "dev", droidBranch: "fixture",
      generatePrompt: () => "Synthetic prompt fixture",
    });
  } else {
    const { exportRuntimeVariable } = await import(${JSON.stringify(join(root, "src/utils/runtime-env.ts"))});
    for (const [name, value] of Object.entries(values)) exportRuntimeVariable(name, value);
  }
} catch (error) {
  caught = error instanceof Error ? error.message : String(error);
  process.exitCode = 7;
}
console.log(${JSON.stringify(marker)} + JSON.stringify({
  DROID_EXEC_RUN_TYPE: process.env.DROID_EXEC_RUN_TYPE || "",
  ALLOWED_TOOLS: process.env.ALLOWED_TOOLS || "",
  DISALLOWED_TOOLS: process.env.DISALLOWED_TOOLS || "",
  caught,
}));
`;

function child(
  mode: string,
  envFile: string | undefined,
  overrides: Record<string, string> = values,
) {
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    ...controlledRuntime.env,
    FIXTURE_MODE: mode,
    FIXTURE_VALUES: JSON.stringify(overrides),
  };
  if (envFile !== undefined) env.GITHUB_ENV = envFile;
  // A fresh runtime prevents unrelated tests' @actions/core mocks/preloads
  // from concealing the actual runner command emitted by these callers.
  const result = Bun.spawnSync({
    cmd: [
      runtime,
      "--config=/dev/null",
      "--env-file=/dev/null",
      "-e",
      childSource,
    ],
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

beforeAll(async () => {
  controlledRuntime = await createControlledRuntime(temporary);
});

afterAll(() => {
  rmSync(temporary, { recursive: true, force: true });
});

describe("real core control", () => {
  it("detects the forbidden fallback from unguarded real actions/core", () => {
    const result = child("control", undefined);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::set-env name=DROID_EXEC_RUN_TYPE::");
    expect(result.stdout).toContain("::set-env name=ALLOWED_TOOLS::");
    expect(receipt(result.stdout).DROID_EXEC_RUN_TYPE).toBe(
      values.DROID_EXEC_RUN_TYPE,
    );
  });
});

describe("existing callers use real core", () => {
  it.each(["droid-review", "droid-security-review", "droid-security-scan"])(
    "keeps explicit %s in-process without runner env authority",
    (runType) => {
      const result = child("run-type", undefined, {
        DROID_EXEC_RUN_TYPE: runType,
      });
      expect(result.exitCode).toBe(0);
      expect(receipt(result.stdout).DROID_EXEC_RUN_TYPE).toBe(runType);
      expect(result.stdout).not.toContain("::set-env");
    },
  );

  it("treats an empty command-file path as in-process only", () => {
    const result = child("run-type", "");
    expect(result.exitCode).toBe(0);
    expect(receipt(result.stdout).DROID_EXEC_RUN_TYPE).toBe(
      values.DROID_EXEC_RUN_TYPE,
    );
    expect(result.stdout).not.toContain("::set-env");
  });

  it("preserves explicit runner persistence with real core", () => {
    const path = file("github-env");
    const result = child("run-type", path);
    expect(result.exitCode).toBe(0);
    expect(commandFile(path).DROID_EXEC_RUN_TYPE).toBe(
      values.DROID_EXEC_RUN_TYPE,
    );
    expect(result.stdout).not.toContain("::set-env");
  });

  it.each([undefined, ""])(
    "exports prompt tools locally with env path %s",
    (path) => {
      const result = child("prompt", path);
      expect(result.exitCode).toBe(0);
      expect(receipt(result.stdout).ALLOWED_TOOLS).toContain("Read");
      expect(receipt(result.stdout).DISALLOWED_TOOLS).toBe(
        "WebSearch,FetchUrl",
      );
      expect(result.stdout).not.toContain("::set-env");
    },
  );
});

describe("runtime variable export boundary", () => {
  it.each([undefined, ""])(
    "sets all three local values with env path %s",
    (path) => {
      const result = child("helper", path);
      expect(result.exitCode).toBe(0);
      const actual = receipt(result.stdout);
      for (const [key, value] of Object.entries(values))
        expect(actual[key]).toBe(value);
      expect(result.stdout).not.toContain("::set-env");
    },
  );

  it("uses real core multiline file commands when explicitly available", () => {
    const path = file("github-env");
    const result = child("helper", path);
    expect(result.exitCode).toBe(0);
    const exported = commandFile(path);
    const local = receipt(result.stdout);
    for (const [key, value] of Object.entries(values)) {
      expect(exported[key]).toBe(value);
      expect(local[key]).toBe(value);
    }
    expect(result.stdout).not.toContain("::set-env");
  });

  it("propagates an invalid explicit runner file instead of downgrading", () => {
    const result = child("helper", join(temporary, "missing-github-env"));
    expect(result.exitCode).toBe(7);
    expect(receipt(result.stdout).caught).toContain("Missing file at path");
    expect(receipt(result.stdout).DROID_EXEC_RUN_TYPE).toBe(
      values.DROID_EXEC_RUN_TYPE,
    );
    expect(result.stdout).not.toContain("::set-env");
  });
});
