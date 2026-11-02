import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { pathToFileURL } from "url";
import { parse } from "yaml";

// The override lets the independently authored artifact run before it is copied
// into the canonical worktree. Normal repository runs use their own root.
const root = process.env.DROID_TAIL_TEST_ROOT ?? resolve(import.meta.dir, "..");
type Step = {
  name: string;
  id?: string;
  if?: string;
  run: string;
  shell: string;
  env: Record<string, string>;
};
type Tail = {
  label: string;
  action: string;
  selector: string;
  role: "debug" | "revoke" | "steward";
  owner: "prepare" | "token";
};
const tails: Tail[] = [
  {
    label: "root debug collector",
    action: "action.yml",
    selector: "collect_debug",
    role: "debug",
    owner: "prepare",
  },
  {
    label: "root token revoker",
    action: "action.yml",
    selector: "Revoke GitHub App token",
    role: "revoke",
    owner: "prepare",
  },
  {
    label: "standalone review token revoker",
    action: "review/action.yml",
    selector: "Revoke GitHub App token",
    role: "revoke",
    owner: "token",
  },
  {
    label: "standalone security token revoker",
    action: "security/action.yml",
    selector: "Revoke GitHub App token",
    role: "revoke",
    owner: "token",
  },
  {
    label: "root CI Steward post-run",
    action: "action.yml",
    selector: "CI Steward post-run",
    role: "steward",
    owner: "prepare",
  },
];
const roles = [
  "lifecycle",
  "post",
  "tracking",
  "validator",
  "runner",
  "debug",
  "revoke",
  "steward",
] as const;
const credentialNames = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OVERRIDE_GITHUB_TOKEN",
  "DEFAULT_WORKFLOW_TOKEN",
  "WORKFLOW_GITHUB_TOKEN",
  "FACTORY_API_KEY",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
] as const;
const credentials = Object.fromEntries(
  credentialNames.map((name) => [
    name,
    `synthetic-${name.toLowerCase()}-redaction-value`,
  ]),
);
const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
let directory: string;
let runtime: string;
let runtimeHash: string;
let frozen: Record<string, string>;
const cleanup = new Set<string>();
const actions = new Map<string, { runs: { steps: Step[] } }>();

function stepFor(tail: Tail): Step {
  const step = actions
    .get(tail.action)!
    .runs.steps.find(
      (candidate) =>
        candidate.id === tail.selector || candidate.name === tail.selector,
    );
  if (!step) throw new Error(`Missing actual workflow tail: ${tail.label}`);
  return step;
}
async function temporary(prefix: string) {
  const path = await mkdtemp(join(directory, prefix));
  cleanup.add(path);
  return path;
}
async function child(
  command: string[],
  cwd: string,
  env: Record<string, string>,
) {
  const process = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exit };
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tail-runtime-security-"));
  for (const action of [
    "action.yml",
    "review/action.yml",
    "security/action.yml",
  ])
    actions.set(action, parse(await readFile(join(root, action), "utf8")));
  runtime = await realpath(process.execPath);
  runtimeHash = hash(await readFile(runtime));
  const helper = pathToFileURL(
    join(root, "src/prepare/review-runtime.ts"),
  ).href;
  const result = await child(
    [
      runtime,
      "--config=/dev/null",
      "--env-file=/dev/null",
      "--eval",
      `const {freezeReviewRuntime}=await import(${JSON.stringify(helper)});console.log("__TAIL_OUTPUTS__"+JSON.stringify(await freezeReviewRuntime()));`,
    ],
    directory,
    { PATH: "/usr/bin:/bin" },
  );
  expect(result.exit).toBe(0);
  const line = result.stdout
    .split("\n")
    .find((line) => line.startsWith("__TAIL_OUTPUTS__"));
  if (!line)
    throw new Error(
      `Real eight-role freeze did not complete: ${result.stderr}`,
    );
  frozen = JSON.parse(line.slice("__TAIL_OUTPUTS__".length));
  cleanup.add(dirname(frozen.review_debug_publisher_path!));
});
afterAll(async () => {
  for (const path of cleanup) await rm(path, { recursive: true, force: true });
  if (directory) await rm(directory, { recursive: true, force: true });
});

type Fixture = {
  dir: string;
  publisher: string;
  publisherHash: string;
  output: string;
  poisoned: string;
  startup: string;
  sentinel: string;
};
async function fixture(bytes?: string): Promise<Fixture> {
  const dir = await temporary("shell-");
  const publisher = join(dir, "publisher.mjs");
  const output = join(dir, "captured.json");
  const sentinel = join(dir, "untrusted-code-ran");
  const poisoned = join(dir, "poisoned-bin");
  const startup = join(dir, "startup.sh");
  await mkdir(poisoned);
  await writeFile(
    startup,
    `echo unsafe-shell-startup > ${JSON.stringify(sentinel)}; exit 97\n`,
  );
  for (const name of ["bun", "sha256sum", "env"]) {
    const path = join(poisoned, name);
    await writeFile(
      path,
      `#!/bin/sh\necho unsafe-path > ${JSON.stringify(sentinel)}\nexit 98\n`,
    );
    await chmod(path, 0o700);
  }
  await writeFile(
    join(dir, "bunfig.toml"),
    'preload = ["./untrusted-preload.ts"]\n',
  );
  await writeFile(
    join(dir, "untrusted-preload.ts"),
    `await Bun.write(${JSON.stringify(sentinel)}, "unsafe-bun-preload");`,
  );
  await writeFile(join(dir, ".env"), "GITHUB_TOKEN=unsafe-dotenv-token\n");
  const source =
    bytes ??
    `import {writeFileSync} from "fs";writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env));`;
  await writeFile(publisher, source);
  return {
    dir,
    publisher,
    publisherHash: hash(Buffer.from(source)),
    output,
    poisoned,
    startup,
    sentinel,
  };
}
async function runTail(
  tail: Tail,
  file: Fixture,
  overrides: Record<string, string> = {},
) {
  const step = stepFor(tail);
  const script = join(file.dir, "tail.sh");
  await writeFile(script, step.run);
  const cleared = Object.fromEntries(
    Object.entries(step.env).filter(([, value]) => value === ""),
  );
  return child([...step.shell.split(" ").slice(0, -1), script], file.dir, {
    PATH: file.poisoned,
    BASH_ENV: file.startup,
    ENV: file.startup,
    NODE_OPTIONS: "--import=/untrusted-node-preload",
    BUN_OPTIONS: "--preload=/untrusted-bun-preload",
    NODE_PATH: "/untrusted-modules",
    HTTPS_PROXY: "https://untrusted.invalid",
    NODE_EXTRA_CA_CERTS: "/untrusted-cert",
    BUN_CONFIG_VERBOSE_FETCH: "true",
    MODEL_POISON: "do-not-inherit",
    ...cleared,
    ...credentials,
    HOME: file.dir,
    RUNNER_TEMP: file.dir,
    DEBUG_ARTIFACTS_DIR: join(file.dir, "staged"),
    REPOSITORY: "synthetic-owner/synthetic-repo",
    GITHUB_API_URL: "https://github.invalid/api",
    GITHUB_SERVER_URL: "https://github.invalid",
    GITHUB_RUN_ID: "321",
    DROID_COMMENT_ID: "123",
    DROID_CONCLUSION: "failure",
    STEWARD_BASE_SHA: "a".repeat(40),
    STEWARD_PROTECTED_PATHS: ".github/workflows/**\nprotected/**",
    STEWARD_RUN_MARKER: "<!-- ci-steward:run=321 count=1 -->",
    GITHUB_ACTION_PATH: join(file.dir, "mutable-action"),
    GITHUB_OUTPUT: join(file.dir, "step-outputs"),
    TRUSTED_TAIL_PATH: file.publisher,
    TRUSTED_TAIL_SHA256: file.publisherHash,
    TRUSTED_RUNTIME_PATH: runtime,
    TRUSTED_RUNTIME_SHA256: runtimeHash,
    ...overrides,
  });
}
async function capture(file: Fixture): Promise<Record<string, string>> {
  return JSON.parse(await readFile(file.output, "utf8"));
}

describe("all privileged executable roles are frozen before model execution", () => {
  it("compiles, hashes and imports all eight real bundles without running entrypoints", async () => {
    for (const role of roles) {
      const path = frozen[`review_${role}_publisher_path`]!;
      expect(path.startsWith("/")).toBe(true);
      expect(hash(await readFile(path))).toBe(
        frozen[`review_${role}_publisher_sha256`]!,
      );
    }
    expect(hash(await readFile(frozen.review_runtime_path!))).toBe(
      frozen.review_runtime_sha256!,
    );
    const result = await child(
      [
        runtime,
        "--config=/dev/null",
        "--env-file=/dev/null",
        "--eval",
        `globalThis.fetch=()=>{throw Error("NETWORK_FORBIDDEN")};for(const path of ${JSON.stringify(roles.map((role) => frozen[`review_${role}_publisher_path`]))})await import(path);console.log("all-eight-imported");`,
      ],
      directory,
      { PATH: "/usr/bin:/bin" },
    );
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("all-eight-imported");
    expect(result.stderr).not.toContain("NETWORK_FORBIDDEN");
  }, 120000);
});

for (const tail of tails)
  describe(tail.label, () => {
    it("uses only pre-model bundle/runtime outputs and ignores edited action source and poisoned startup", async () => {
      const file = await fixture();
      const actionSource = join(file.dir, "mutable-action/src");
      for (const relative of [
        "entrypoints/collect-debug-artifacts.ts",
        "entrypoints/revoke-github-token.ts",
        "steward/postrun.ts",
      ]) {
        const path = join(actionSource, relative);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
          path,
          `await Bun.write(${JSON.stringify(file.sentinel)}, "mutable-source-ran")`,
        );
      }
      const result = await runTail(tail, file);
      expect(result.exit).toBe(0);
      expect(await Bun.file(file.sentinel).exists()).toBe(false);
      const env = await capture(file);
      expect(env.PATH).toBe("/usr/bin:/bin");
      for (const key of [
        "BASH_ENV",
        "ENV",
        "NODE_OPTIONS",
        "BUN_OPTIONS",
        "NODE_PATH",
        "HTTPS_PROXY",
        "NODE_EXTRA_CA_CERTS",
        "BUN_CONFIG_VERBOSE_FETCH",
        "MODEL_POISON",
        "TRUSTED_TAIL_PATH",
        "TRUSTED_TAIL_SHA256",
        "TRUSTED_RUNTIME_PATH",
        "TRUSTED_RUNTIME_SHA256",
      ])
        expect(env[key]).toBeUndefined();
      if (tail.role === "debug")
        for (const key of credentialNames)
          expect(env[key]).toBe(credentials[key]!);
      else
        for (const key of credentialNames)
          if (
            key !== "GITHUB_TOKEN" &&
            !(tail.role === "revoke" && key === "OVERRIDE_GITHUB_TOKEN")
          )
            expect(env[key]).toBeUndefined();
      if (tail.role === "steward") {
        expect(env.HOME).toBe(file.dir);
        expect(env.STEWARD_BASE_SHA).toBe("a".repeat(40));
        expect(env.STEWARD_PROTECTED_PATHS).toContain("protected/**");
        expect(env.STEWARD_RUN_MARKER).toContain("count=1");
      }
    });
    it.each([
      "publisher-tamper",
      "runtime-tamper",
      "missing-publisher",
      "missing-runtime",
      "missing-bindings",
      "symlink-publisher",
      "relative-publisher",
    ])("fails closed for %s without any mutable fallback", async (attack) => {
      const file = await fixture();
      const overrides: Record<string, string> = {};
      if (attack === "publisher-tamper")
        await writeFile(
          file.publisher,
          `await Bun.write(${JSON.stringify(file.sentinel)}, "tampered")`,
        );
      if (attack === "runtime-tamper")
        overrides.TRUSTED_RUNTIME_SHA256 = "0".repeat(64);
      if (attack === "missing-publisher")
        overrides.TRUSTED_TAIL_PATH = join(file.dir, "not-present.mjs");
      if (attack === "missing-runtime")
        overrides.TRUSTED_RUNTIME_PATH = join(file.dir, "not-present-bun");
      if (attack === "missing-bindings") {
        overrides.TRUSTED_TAIL_PATH = "";
        overrides.TRUSTED_TAIL_SHA256 = "";
        overrides.TRUSTED_RUNTIME_PATH = "";
        overrides.TRUSTED_RUNTIME_SHA256 = "";
      }
      if (attack === "symlink-publisher") {
        const link = join(file.dir, "linked-publisher.mjs");
        await symlink(file.publisher, link);
        overrides.TRUSTED_TAIL_PATH = link;
      }
      if (attack === "relative-publisher")
        overrides.TRUSTED_TAIL_PATH = "publisher.mjs";
      const result = await runTail(tail, file, overrides);
      expect(result.exit).not.toBe(0);
      expect(await Bun.file(file.output).exists()).toBe(false);
      expect(await Bun.file(file.sentinel).exists()).toBe(false);
    });
  });

describe("actual collector and token cleanup behavior", () => {
  it("redacts all eight credential values with the real frozen collector", async () => {
    const collector = await readFile(
      frozen.review_debug_publisher_path!,
      "utf8",
    );
    const file = await fixture(
      `globalThis.fetch=()=>{throw Error("NETWORK_FORBIDDEN")};\n${collector.replace(/^#![^\n]*\n/, "")}`,
    );
    const logs = join(file.dir, ".factory/logs");
    await mkdir(logs, { recursive: true });
    await writeFile(
      join(logs, "credentials.txt"),
      credentialNames.map((key) => `${key}=${credentials[key]}`).join("\n"),
    );
    const result = await runTail(tails[0]!, file);
    expect({ exit: result.exit, stderr: result.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
    const staged = await readFile(
      join(file.dir, "staged/factory/logs/credentials.txt"),
      "utf8",
    );
    for (const secret of Object.values(credentials))
      expect(staged).not.toContain(secret);
    expect(staged).toContain("[REDACTED]");
  });
  for (const tail of tails.filter((tail) => tail.role === "revoke"))
    it.each(["caller-override", "empty-token"])(
      `${tail.label} does not contact any API for %s`,
      async (mode) => {
        const revoker = await readFile(
          frozen.review_revoke_publisher_path!,
          "utf8",
        );
        // Instrument only the test copy so even a regression cannot make a
        // live DELETE request. The workflow guard still hashes these bytes.
        const file = await fixture(
          `globalThis.fetch=()=>{console.error("NETWORK_FORBIDDEN");throw Error("NETWORK_FORBIDDEN")};\n${revoker.replace(/^#![^\n]*\n/, "")}`,
        );
        const result = await runTail(tail, file, {
          GITHUB_TOKEN:
            mode === "empty-token" ? "" : "synthetic-caller-owned-token",
          OVERRIDE_GITHUB_TOKEN:
            mode === "caller-override" ? "synthetic-caller-owned-token" : "",
        });
        expect(result.exit).toBe(0);
        expect(result.stdout + result.stderr).not.toContain(
          "NETWORK_FORBIDDEN",
        );
        expect(result.stdout).toContain(
          mode === "empty-token"
            ? "No GitHub App token to revoke"
            : "provided github_token",
        );
      },
    );
  it("keeps upload gated on the collector's successful outcome", () => {
    const upload = actions
      .get("action.yml")!
      .runs.steps.find((step) =>
        String((step as Step & { uses?: string }).uses ?? "").startsWith(
          "actions/upload-artifact@",
        ),
      );
    expect(upload?.if).toBe(
      "always() && steps.collect_debug.outcome == 'success'",
    );
  });
});

type PreparationState = {
  events: string[];
  outputs: Record<string, string>;
};
type PreparationBuild = {
  root: string;
  entrypoint: "prepare.ts" | "get-token.ts";
  mocks: [string, string][];
  coreMock: string;
  program: string;
  omitImmediateTokenOutput: boolean;
};
// Bun 1.2.11 retains plugin/file caches across builds. Serialize this function
// into a fresh child so the shared test process never registers these plugins.
async function buildPreparationInChild(options: PreparationBuild) {
  const { root, entrypoint, coreMock, program, omitImmediateTokenOutput } =
    options;
  const mocks = new Map(options.mocks);
  const build = await Bun.build({
    entrypoints: [join(root, "src/entrypoints", entrypoint)],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "tail-preparation-mocked-network-boundaries",
        setup(builder) {
          builder.onResolve({ filter: /^@actions\/core$/ }, () => ({
            path: "core",
            namespace: "tail-test-core",
          }));
          builder.onLoad({ filter: /.*/, namespace: "tail-test-core" }, () => ({
            contents: coreMock,
            loader: "ts",
          }));
          builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
            const relative = path.slice(root.length + 1);
            if (
              omitImmediateTokenOutput &&
              relative === "src/entrypoints/prepare.ts"
            ) {
              const source = await readFile(path, "utf8");
              const mutated = source.replace(
                /^\s*core\.setOutput\("github_token", githubToken\);\r?\n/m,
                "",
              );
              if (source === mutated)
                throw new Error(
                  "Missing immediate token-output negative control",
                );
              return { contents: mutated, loader: "ts" };
            }
            const contents = mocks.get(relative);
            return contents === undefined
              ? undefined
              : { contents, loader: "ts" };
          });
        },
      },
    ],
  });
  if (!build.success || !build.outputs[0])
    throw new Error(`Could not compile real ${entrypoint}: ${build.logs}`);
  await writeFile(program, Buffer.from(await build.outputs[0].arrayBuffer()));
}
async function runPreparation(
  entrypoint: "prepare.ts" | "get-token.ts",
  file: Fixture,
  failFreeze = false,
  failConfig = false,
  omitImmediateTokenOutput = false,
) {
  const resultPath = join(file.dir, "preparation.json");
  const shared = `import {writeFileSync} from "fs";const state=globalThis.__tailTestState??={events:[],outputs:{}};const save=()=>writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(state));`;
  const bound = {
    review_revoke_publisher_path: file.publisher,
    review_revoke_publisher_sha256: file.publisherHash,
    review_runtime_path: runtime,
    review_runtime_sha256: runtimeHash,
  };
  const mocks = new Map<string, string>([
    [
      "src/prepare/review-runtime.ts",
      `${shared}import * as core from "@actions/core";export async function freezeReviewRuntime(){state.events.push("freeze");save();${failFreeze ? 'throw Error("synthetic freeze failure");' : `const outputs=${JSON.stringify(bound)};for(const [key,value]of Object.entries(outputs))core.setOutput(key,value);return outputs;`}}`,
    ],
    [
      "src/github/token.ts",
      `${shared}export async function setupGitHubToken(){state.events.push("mint");save();return "synthetic-minted-token";}`,
    ],
    [
      "src/github/context.ts",
      'export const isEntityContext=()=>false;export const parseGitHubContext=()=>({eventName:"issues",inputs:{}});',
    ],
    ["src/github/api/client.ts", "export const createOctokit=()=>({});"],
    [
      "src/github/validation/permissions.ts",
      "export const checkWritePermissions=async()=>true;",
    ],
    ["src/tag/index.ts", "export const shouldTriggerTag=()=>false;"],
    [
      "src/prepare/index.ts",
      'export const prepare=()=>{throw Error("No-trigger preparation reached a model");};',
    ],
    [
      "src/prepare/review-config.ts",
      failConfig
        ? `${shared}export async function initializeReviewConfig(){state.events.push("config");save();throw Error("synthetic configuration failure");}`
        : "export const initializeReviewConfig=async()=>{};",
    ],
    [
      "src/entrypoints/collect-inputs.ts",
      "export const collectActionInputsPresence=()=>{};",
    ],
  ]);
  const coreMock = `${shared}export const setOutput=(key,value)=>{state.outputs[key]=String(value);save();};export const setSecret=()=>{};export const setFailed=(message)=>{state.events.push("failed");save();};export const exportVariable=()=>{};export const warning=()=>{};export const info=()=>{};`;
  const program = join(file.dir, "prepare.mjs");
  const builder = join(file.dir, "build-preparation.mjs");
  const options: PreparationBuild = {
    root,
    entrypoint,
    mocks: [...mocks],
    coreMock,
    program,
    omitImmediateTokenOutput,
  };
  await writeFile(
    builder,
    `import {readFile,writeFile} from "fs/promises";import {join} from "path";\nawait (${buildPreparationInChild.toString()})(${JSON.stringify(options)});`,
  );
  const built = await child(
    [runtime, "--config=/dev/null", "--env-file=/dev/null", builder],
    file.dir,
    { PATH: "/usr/bin:/bin" },
  );
  if (built.exit !== 0)
    throw new Error(
      `Isolated preparation build failed: ${built.stdout}\n${built.stderr}`,
    );
  const result = await child(
    [runtime, "--config=/dev/null", "--env-file=/dev/null", program],
    file.dir,
    { PATH: "/usr/bin:/bin" },
  );
  const state: PreparationState = JSON.parse(
    await readFile(resultPath, "utf8"),
  );
  return { ...result, state };
}
function bindings(tail: Tail, state: PreparationState) {
  const result: Record<string, string> = {};
  for (const name of [
    "TRUSTED_TAIL_PATH",
    "TRUSTED_TAIL_SHA256",
    "TRUSTED_RUNTIME_PATH",
    "TRUSTED_RUNTIME_SHA256",
    "GITHUB_TOKEN",
  ]) {
    const expression = stepFor(tail).env[name]!;
    const match = /^\$\{\{ steps\.(prepare|token)\.outputs\.(\w+) \}\}$/.exec(
      expression,
    );
    expect(match?.[1]).toBe(tail.owner);
    if (!match) throw new Error(`Unbound cleanup authority ${expression}`);
    result[name] = state.outputs[match[2]!] ?? "";
  }
  return result;
}

describe("cleanup survives no-trigger and failed-prompt paths", () => {
  it("freezes root cleanup before minting and retains real outputs on no-trigger return", async () => {
    const file = await fixture();
    const prepared = await runPreparation("prepare.ts", file);
    expect(prepared.exit).toBe(0);
    expect(prepared.state.events.indexOf("freeze")).toBeLessThan(
      prepared.state.events.indexOf("mint"),
    );
    expect(prepared.state.outputs.contains_trigger).toBe("false");
    const tail = tails[1]!;
    expect(stepFor(tail).if).toContain("always()");
    expect(stepFor(tail).if).not.toContain("contains_trigger");
    const result = await runTail(tail, file, {
      ...bindings(tail, prepared.state),
      OVERRIDE_GITHUB_TOKEN: "",
    });
    expect(result.exit).toBe(0);
    expect((await capture(file)).GITHUB_TOKEN).toBe("synthetic-minted-token");
  });
  it("retains the minted token and frozen cleanup manifest when configuration throws after minting", async () => {
    const file = await fixture();
    const prepared = await runPreparation("prepare.ts", file, false, true);
    expect(prepared.exit).not.toBe(0);
    expect(prepared.state.events).toEqual([
      "freeze",
      "mint",
      "config",
      "failed",
    ]);
    for (const [name, value] of Object.entries({
      github_token: "synthetic-minted-token",
      review_revoke_publisher_path: file.publisher,
      review_revoke_publisher_sha256: file.publisherHash,
      review_runtime_path: runtime,
      review_runtime_sha256: runtimeHash,
      prepare_error: "synthetic configuration failure",
    }))
      expect(prepared.state.outputs[name]).toBe(value);
    const tail = tails[1]!;
    const result = await runTail(tail, file, {
      ...bindings(tail, prepared.state),
      OVERRIDE_GITHUB_TOKEN: "",
    });
    expect(result.exit).toBe(0);
    expect((await capture(file)).GITHUB_TOKEN).toBe("synthetic-minted-token");
    // Mutate only Bun's in-memory source copy. Without prepare's exact-case
    // output publication, the same post-mint failure must lose its cleanup token.
    const negativeFile = await fixture();
    const negative = await runPreparation(
      "prepare.ts",
      negativeFile,
      false,
      true,
      true,
    );
    expect(negative.exit).not.toBe(0);
    expect(negative.state.events).toEqual([
      "freeze",
      "mint",
      "config",
      "failed",
    ]);
    expect(negative.state.outputs.github_token).toBeUndefined();
  });
  for (const tail of tails.filter((tail) => tail.owner === "token"))
    it(`${tail.label} uses token-step outputs even when the prompt never produced outputs`, async () => {
      const file = await fixture();
      const token = await runPreparation("get-token.ts", file);
      expect(token.exit).toBe(0);
      expect(token.state.events.indexOf("freeze")).toBeLessThan(
        token.state.events.indexOf("mint"),
      );
      expect(stepFor(tail).if).toContain("inputs.github_token == ''");
      expect(Object.values(stepFor(tail).env).join("\n")).not.toContain(
        "steps.prompt.outputs",
      );
      const result = await runTail(tail, file, {
        ...bindings(tail, token.state),
        OVERRIDE_GITHUB_TOKEN: "",
      });
      expect(result.exit).toBe(0);
      expect((await capture(file)).GITHUB_TOKEN).toBe("synthetic-minted-token");
    });
  it("does not mint a token or execute mutable cleanup if the early freeze fails", async () => {
    const file = await fixture();
    const prepared = await runPreparation("prepare.ts", file, true);
    expect(prepared.exit).not.toBe(0);
    expect(prepared.state.events).not.toContain("mint");
    const result = await runTail(tails[1]!, file, {
      ...bindings(tails[1]!, prepared.state),
      OVERRIDE_GITHUB_TOKEN: "",
    });
    expect(result.exit).not.toBe(0);
    expect(await Bun.file(file.output).exists()).toBe(false);
  });
});
