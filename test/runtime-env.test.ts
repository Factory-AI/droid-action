import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
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
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "droid-runtime-env-"));
const runtime = realpathSync(process.execPath);
const runtimeHash = createHash("sha256")
  .update(readFileSync(runtime))
  .digest("hex");
const marker = "RUNTIME_ENV_RECEIPT:";
const values = {
  DROID_EXEC_RUN_TYPE: "droid-security-review",
  ALLOWED_TOOLS: "Read,LS\nfixture\r\n%value%",
  DISALLOWED_TOOLS: "WebSearch,FetchUrl",
};
let sequence = 0;
let validator = "";
let validatorWithNetworkFixtures = "";

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
      prBranchData: { headRefName: "fixture", headRefOid: "b".repeat(40), isFork: false, headRevision: "HEAD" },
      reviewArtifacts: { diffPath: "fixture.diff", commentsPath: "fixture-comments.json", descriptionPath: "fixture-description.txt" },
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
    HOME: temporary,
    RUNNER_TEMP: temporary,
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

async function bundleValidator(mockNetwork: boolean): Promise<string> {
  const output = join(
    temporary,
    mockNetwork ? "validator-fixtures" : "validator-real",
  );
  const githubFixture = `export function createOctokit() {
                  return { graphql: async () => ({ repository: { pullRequest: {
                    baseRefName: "dev", headRefName: "fixture", headRefOid: "b".repeat(40),
                    isCrossRepository: false, title: "Fixture", body: "Synthetic fixture",
                    headRepository: { nameWithOwner: "fixture/fixture" },
                    baseRepository: { nameWithOwner: "fixture/fixture" }
                  } } }) };
                }`;
  const source = `
const built = await Bun.build({
  entrypoints: [${JSON.stringify(join(root, "src/entrypoints/prepare-validator.ts"))}],
  outdir: ${JSON.stringify(output)}, target: "bun",
  plugins: ${mockNetwork} ? [{
    name: "only-github-and-model-policy-fixtures",
    setup(build) {
      build.onLoad({ filter: new RegExp("/src/github/api/client\\\\.ts$") }, () => ({
        loader: "ts", contents: ${JSON.stringify(githubFixture)}
      }));
      build.onLoad({ filter: new RegExp("/src/utils/model-policy\\\\.ts$") }, () => ({
        loader: "ts", contents: "export async function applyModelPolicyFallback(config) { return config; }"
      }));
    }
  }] : []
});
if (!built.success) throw new Error(built.logs.map(String).join("\\n"));
console.log("FROZEN_VALIDATOR_PATH:" + built.outputs[0].path);
`;
  const built = Bun.spawnSync({
    cmd: [runtime, "--config=/dev/null", "--env-file=/dev/null", "-e", source],
    cwd: root,
    env: { PATH: "/usr/bin:/bin", HOME: temporary },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (built.exitCode !== 0) {
    throw new Error(built.stderr.toString());
  }
  const path = built.stdout
    .toString()
    .split("\n")
    .find((line) => line.startsWith("FROZEN_VALIDATOR_PATH:"))
    ?.slice("FROZEN_VALIDATOR_PATH:".length);
  if (!path) throw new Error("Missing frozen validator fixture");
  return path;
}

function wrapper(action: string, fullPath: boolean) {
  const document: unknown = parse(readFileSync(join(root, action), "utf8"));
  const steps = record(record(document).runs).steps;
  if (!Array.isArray(steps)) throw new Error("Missing composite steps");
  const step = steps.find((item) => record(item).id === "prepare_validator");
  const source = record(step).run;
  if (typeof source !== "string") throw new Error("Missing validator script");
  const output = file("github-output");
  const outerEnv = file("outer-github-env");
  const event = file(
    "event.json",
    JSON.stringify({
      action: "opened",
      number: 1,
      repository: {
        name: "fixture",
        full_name: "fixture/fixture",
        owner: { login: "fixture" },
        default_branch: "dev",
      },
      sender: { login: "fixture-author", type: "User" },
      pull_request: {
        number: 1,
        title: "Fixture",
        body: "Synthetic fixture",
        user: { login: "fixture-author" },
        head: {
          ref: "fixture",
          sha: "b".repeat(40),
          repo: { full_name: "fixture/fixture" },
        },
        base: {
          ref: "dev",
          sha: "a".repeat(40),
          repo: { full_name: "fixture/fixture" },
        },
      },
    }),
  );
  const candidates = fullPath
    ? file("candidates.json", JSON.stringify({ comments: [] }))
    : join(temporary, `missing-candidates-${sequence++}.json`);
  const publisher = fullPath ? validatorWithNetworkFixtures : validator;
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: temporary,
    GITHUB_ENV: outerEnv,
    GITHUB_OUTPUT: output,
    GITHUB_EVENT_PATH: event,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_ACTOR: "fixture-author",
    GITHUB_RUN_ID: "1",
    GITHUB_REPOSITORY: "fixture/fixture",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_TOKEN: "fixture-token-not-a-real-credential",
    RUNNER_TEMP: temporary,
    REVIEW_PUBLISHER_PATH: publisher,
    REVIEW_PUBLISHER_SHA256: createHash("sha256")
      .update(readFileSync(publisher))
      .digest("hex"),
    REVIEW_RUNTIME_PATH: runtime,
    REVIEW_RUNTIME_SHA256: runtimeHash,
    REVIEW_CANDIDATES_PATH: candidates,
    REVIEW_VALIDATED_PATH: join(temporary, "validated.json"),
    DROID_COMMENT_ID: "7",
  };
  const result = Bun.spawnSync({
    cmd: [
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-p",
      "-eo",
      "pipefail",
      "-c",
      source,
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
    output,
    outerEnv,
  };
}

beforeAll(async () => {
  validator = await bundleValidator(false);
  validatorWithNetworkFixtures = await bundleValidator(true);
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

  it.each(["action.yml", "review/action.yml", "security/action.yml"])(
    "runs the unchanged %s validator allowlist without GITHUB_ENV",
    (action) => {
      const result = wrapper(action, false);
      expect(result.exitCode).toBe(0);
      expect(commandFile(result.output).validator_should_run).toBe("false");
      expect(readFileSync(result.outerEnv, "utf8")).toBe("");
      expect(result.stdout).not.toContain("::set-env");
    },
  );

  it("hands actual validator args and MCP outputs onward without job-env persistence", () => {
    const result = wrapper("action.yml", true);
    expect(result.exitCode).toBe(0);
    const output = commandFile(result.output);
    expect(output.validator_should_run).toBe("true");
    expect(output.droid_args).toContain(
      '--enabled-tools "Read,Grep,Glob,LS,Execute,ApplyPatch,Create,Edit,Skill"',
    );
    expect(output.droid_args).not.toContain("github_comment");
    expect(output.mcp_tools).toBe('{"mcpServers":{}}');
    expect(Object.keys(output)).not.toContain("GITHUB_TOKEN");
    expect(JSON.stringify(output)).not.toContain(
      "fixture-token-not-a-real-credential",
    );
    expect(JSON.stringify(output)).not.toContain(result.outerEnv);
    expect(readFileSync(result.outerEnv, "utf8")).toBe("");
    expect(result.stdout).not.toContain("::set-env");
  });
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
