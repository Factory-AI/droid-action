import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import {
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
import {
  createControlledRuntime,
  privateStartupEnvironment,
} from "./helpers/controlled-runtime";

const root = resolve(import.meta.dir, "..");
type Step = {
  name: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  shell?: string;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
};
type Role = "plan" | "assess" | "publish";
const stepIds: Record<Role, string> = {
  plan: "risk_plan",
  assess: "risk_assess",
  publish: "risk_publish",
};
const ENFORCE = "Require a published risk assessment";
const INSTALL = "Install Droid CLI for risk assessment";

// What each step's program may see, beyond PATH. Anything else the step or
// the runner holds must not cross the `env -i` boundary.
const allowed: Record<Role, string[]> = {
  plan: [
    "GITHUB_OUTPUT",
    "RUNNER_TEMP",
    "GITHUB_EVENT_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "RISK_EVENT_ACTION",
    "RISK_EVENT_PR_NUMBER",
    "RISK_EVENT_HEAD_SHA",
    "RISK_EVENT_HEAD_REPO",
    "RISK_PR_NUMBER",
    "RISK_DRY_RUN",
    "FACTORY_API_KEY",
    "FACTORY_API_BASE_URL",
  ],
  assess: [
    "RUNNER_HOME",
    "RISK_JUDGE_PATH",
    "GITHUB_OUTPUT",
    "GITHUB_REPOSITORY",
    "GITHUB_WORKSPACE",
    "GITHUB_API_URL",
    "GITHUB_SERVER_URL",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "RISK_PLAN_PATH",
    "RISK_PLAN_SHA256",
    "RISK_PLAN_PR_NUMBER",
    "RISK_CLI_PATH",
    "RISK_CLI_SHA256",
    "INPUT_PATH_TO_DROID_EXECUTABLE",
    "REVIEW_GITHUB_TOKEN",
    "OVERRIDE_GITHUB_TOKEN",
    "FACTORY_API_KEY",
    "FACTORY_API_BASE_URL",
  ],
  publish: [
    "GITHUB_OUTPUT",
    "GITHUB_EVENT_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "RISK_PLAN_PR_NUMBER",
    "RISK_PLAN_HEAD_SHA",
    "RISK_DRY_RUN",
    "RISK_ASSESS_STATUS",
    "RISK_ASSESSMENT_PATH",
    "RISK_ASSESSMENT_SHA256",
    "FACTORY_API_KEY",
    "FACTORY_API_BASE_URL",
  ],
};
// Set by the runner or the job, never by the step's own `env`.
const ambient = {
  GITHUB_OUTPUT: "",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid/request",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc-request-token",
  ACTIONS_RUNTIME_TOKEN: "synthetic-runtime-token",
  GITHUB_TOKEN: "synthetic-job-token",
  GH_TOKEN: "synthetic-gh-token",
  GITHUB_EVENT_PATH: "/untrusted/event.json",
  HTTPS_PROXY: "https://untrusted.invalid",
  NODE_EXTRA_CA_CERTS: "/untrusted-cert",
  MODEL_POISON: "do-not-inherit",
};

const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
let directory: string;
let steps: Step[];
let inputs: Record<string, { default?: string }>;

const stepFor = (role: Role) => {
  const step = steps.find((candidate) => candidate.id === stepIds[role]);
  if (!step?.run || !step.shell || !step.env)
    throw new Error(`Missing risk step: ${role}`);
  return step as Required<Pick<Step, "run" | "shell" | "env">> & Step;
};
const indexOf = (selector: string) => {
  const index = steps.findIndex(
    (step) => step.id === selector || step.name === selector,
  );
  if (index === -1) throw new Error(`Missing step: ${selector}`);
  return index;
};

async function child(
  command: string[],
  cwd: string,
  env: Record<string, string>,
) {
  const process = Bun.spawn(command, {
    cwd,
    env: { ...(await privateStartupEnvironment(cwd)), ...env },
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

type Fixture = {
  dir: string;
  runtime: string;
  runtimeHash: string;
  publisher: string;
  publisherHash: string;
  captured: string;
  outputs: string;
  sentinel: string;
  poisoned: string;
  startup: string;
  wrapperKeys: string[];
};
async function fixture(source?: string): Promise<Fixture> {
  const dir = await mkdtemp(join(directory, "step-"));
  const controlled = await createControlledRuntime(dir, dir);
  const captured = join(dir, "captured.json");
  const sentinel = join(dir, "untrusted-code-ran");
  const poisoned = join(dir, "poisoned-bin");
  const startup = join(dir, "startup.sh");
  await mkdir(poisoned);
  await writeFile(
    startup,
    `echo unsafe-shell-startup > ${JSON.stringify(sentinel)}; exit 97\n`,
  );
  for (const name of ["bun", "sha256sum", "env"])
    await writeFile(
      join(poisoned, name),
      `#!/bin/sh\necho unsafe-path > ${JSON.stringify(sentinel)}\nexit 98\n`,
      { mode: 0o700 },
    );
  const bytes =
    source ??
    `import {writeFileSync} from "fs";writeFileSync(${JSON.stringify(captured)}, JSON.stringify(process.env));`;
  const publisher = join(dir, "publisher.mjs");
  await writeFile(publisher, bytes);
  // The runner creates the step's output file before the step starts.
  await writeFile(join(dir, "step-outputs"), "");
  return {
    dir,
    runtime: controlled.path,
    runtimeHash: controlled.sha256,
    publisher,
    publisherHash: hash(bytes),
    captured,
    outputs: join(dir, "step-outputs"),
    sentinel,
    poisoned,
    startup,
    wrapperKeys: Object.keys(controlled.env),
  };
}

/**
 * Runs a risk step's real script as the runner would: every name the step
 * declares is set, poisoned startup and loader variables are in place, and
 * the job's other credentials sit in the environment.
 */
async function runStep(
  role: Role,
  file: Fixture,
  overrides: Record<string, string> = {},
) {
  const step = stepFor(role);
  const script = join(file.dir, "step.sh");
  await writeFile(script, step.run);
  const declared = Object.fromEntries(
    Object.entries(step.env).map(([name, value]) => [
      name,
      value === "" ? "" : `declared-${name.toLowerCase()}`,
    ]),
  );
  return child([...step.shell.split(" ").slice(0, -1), script], file.dir, {
    ...ambient,
    ...declared,
    PATH: file.poisoned,
    HOME: file.dir,
    BASH_ENV: file.startup,
    ENV: file.startup,
    NODE_OPTIONS: "--import=/untrusted-node-preload",
    BUN_OPTIONS: "--preload=/untrusted-bun-preload",
    NODE_PATH: "/untrusted-modules",
    GITHUB_OUTPUT: file.outputs,
    TRUSTED_TAIL_PATH: file.publisher,
    TRUSTED_TAIL_SHA256: file.publisherHash,
    TRUSTED_RUNTIME_PATH: file.runtime,
    TRUSTED_RUNTIME_SHA256: file.runtimeHash,
    ...overrides,
  });
}
async function capture(file: Fixture): Promise<Record<string, string>> {
  const env: Record<string, string> = JSON.parse(
    await readFile(file.captured, "utf8"),
  );
  // The fixture runtime restores its own startup paths, and a shell adds
  // its bookkeeping; neither comes from the step.
  for (const name of [...file.wrapperKeys, "PWD", "OLDPWD", "SHLVL", "_"])
    delete env[name];
  return env;
}
function stepOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const match of text.matchAll(
    /^(\w+)<<(ghadelimiter_[\w-]+)\n([\s\S]*?)\n\2$/gmu,
  ))
    outputs[match[1]!] = match[3]!;
  return outputs;
}

beforeAll(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "risk-wiring-")));
  const action = parse(await readFile(join(root, "action.yml"), "utf8"));
  steps = action.runs.steps;
  inputs = action.inputs;
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("risk phase wiring", () => {
  it("is off unless the workflow turns it on", () => {
    expect(inputs.risk_assessment!.default).toBe("false");
    expect(inputs.risk_dry_run!.default).toBe("false");
    expect(stepFor("plan").if).toBe(
      "${{ !cancelled() && inputs.risk_assessment == 'true' }}",
    );
    // Every later step hangs off the plan's answer, so none can run when
    // the phase is off.
    for (const selector of [INSTALL, "risk_assess", "risk_publish", ENFORCE])
      expect(steps[indexOf(selector)]!.if).toContain(
        "steps.risk_plan.outputs.action == 'judge'",
      );
  });

  it("runs after the review has finished and before the token is revoked and debug files are collected", () => {
    const order = [
      "Review lifecycle finalize",
      "risk_plan",
      INSTALL,
      "risk_assess",
      "risk_publish",
      ENFORCE,
      "collect_debug",
      "Revoke GitHub App token",
    ].map(indexOf);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(order[5]! - order[1]!).toBe(4);
    expect(indexOf("Revoke GitHub App token")).toBe(steps.length - 1);
  });

  it("fails the job only in the last step: when the plan step failed, or a planned head got no publication", () => {
    for (const role of ["plan", "assess", "publish"] as const)
      expect(stepFor(role)["continue-on-error"]).toBe(true);
    const enforce = steps[indexOf(ENFORCE)]!;
    expect(enforce["continue-on-error"]).toBeUndefined();
    expect(enforce.if).toBe(
      "${{ !cancelled() && (steps.risk_plan.outcome == 'failure' || (steps.risk_plan.outputs.action == 'judge' && steps.risk_assess.outputs.status != 'stale_head' && steps.risk_publish.outputs.status == '')) }}",
    );
    expect(enforce.run!.trimEnd()).toEndWith("\nexit 1");
    expect(stepFor("publish").if).toBe(
      "${{ !cancelled() && steps.risk_plan.outputs.action == 'judge' && steps.risk_assess.outputs.status != 'stale_head' }}",
    );
  });

  it("installs a CLI only when no review session froze one", () => {
    expect(steps[indexOf(INSTALL)]!.if).toBe(
      "${{ !cancelled() && steps.risk_plan.outputs.action == 'judge' && steps.review_cli.outputs.review_cli_path == '' && inputs.path_to_droid_executable == '' }}",
    );
    const { env } = stepFor("assess");
    expect(env.RISK_CLI_PATH).toBe(
      "${{ steps.review_cli.outputs.review_cli_path }}",
    );
    expect(env.RISK_CLI_SHA256).toBe(
      "${{ steps.review_cli.outputs.review_cli_sha256 }}",
    );
  });

  it.each(["plan", "assess", "publish"] as const)(
    "binds the %s step to code frozen before the first model ran",
    (role) => {
      const { env, run } = stepFor(role);
      expect(env.TRUSTED_TAIL_PATH).toBe(
        `\${{ steps.prepare.outputs.review_risk_${role}_publisher_path }}`,
      );
      expect(env.TRUSTED_TAIL_SHA256).toBe(
        `\${{ steps.prepare.outputs.review_risk_${role}_publisher_sha256 }}`,
      );
      expect(env.TRUSTED_RUNTIME_PATH).toBe(
        "${{ steps.prepare.outputs.review_runtime_path }}",
      );
      expect(env.TRUSTED_RUNTIME_SHA256).toBe(
        "${{ steps.prepare.outputs.review_runtime_sha256 }}",
      );
      for (const mutable of ["GITHUB_ACTION_PATH", "src/", "bun run "])
        expect(run).not.toContain(mutable);
    },
  );

  it("names the pull request from the event the runner holds, not from a file on disk", () => {
    const { env, run } = stepFor("plan");
    expect(env.RISK_EVENT_ACTION).toBe("${{ github.event.action }}");
    expect(env.RISK_EVENT_PR_NUMBER).toBe(
      "${{ github.event.pull_request.number }}",
    );
    expect(env.RISK_EVENT_HEAD_SHA).toBe(
      "${{ github.event.pull_request.head.sha }}",
    );
    expect(env.RISK_EVENT_HEAD_REPO).toBe(
      "${{ github.event.pull_request.head.repo.full_name }}",
    );
    expect(run).not.toContain("GITHUB_EVENT_PATH");
  });

  it("gives a GitHub token to the judge step alone, and the workflow token to none", () => {
    const tokenSources = (role: Role) =>
      Object.entries(stepFor(role).env)
        .filter(([, value]) => /token|secrets\./iu.test(value))
        .map(([name, value]) => `${name}=${value}`);
    expect(tokenSources("plan")).toEqual([]);
    expect(tokenSources("publish")).toEqual([]);
    expect(tokenSources("assess")).toEqual([
      "REVIEW_GITHUB_TOKEN=${{ steps.prepare.outputs.github_token }}",
      "OVERRIDE_GITHUB_TOKEN=${{ inputs.github_token }}",
    ]);
  });
});

describe.each(["plan", "assess", "publish"] as const)(
  "the %s step's script",
  (role) => {
    it("passes its program exactly the allow-listed environment", async () => {
      const file = await fixture();
      const result = await runStep(role, file);
      expect({ exit: result.exit, stderr: result.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(await Bun.file(file.sentinel).exists()).toBe(false);
      const env = await capture(file);
      expect(env.PATH).toBe("/usr/bin:/bin");
      const expected = allowed[role].filter(
        // The fixture runtime replaces this one with its own.
        (name) => name !== "RUNNER_TEMP",
      );
      expect(Object.keys(env).sort()).toEqual([...expected, "PATH"].sort());
      for (const name of expected) {
        if (name === "GITHUB_OUTPUT") expect(env[name]).toBe(file.outputs);
        else if (name === "RUNNER_HOME")
          expect(env[name]).toBe("declared-review_home");
        else if (name === "RISK_JUDGE_PATH")
          expect(env[name]).toBe("declared-review_path");
        else if (name in ambient)
          expect(env[name]).toBe(ambient[name as keyof typeof ambient]);
        else expect(env[name]).toBe(`declared-${name.toLowerCase()}`);
      }
    });

    it.each([
      "publisher-tamper",
      "runtime-tamper",
      "missing-publisher",
      "missing-bindings",
      "symlink-publisher",
      "relative-publisher",
    ])("refuses to run anything for %s", async (attack) => {
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
      if (attack === "missing-bindings")
        for (const name of [
          "TRUSTED_TAIL_PATH",
          "TRUSTED_TAIL_SHA256",
          "TRUSTED_RUNTIME_PATH",
          "TRUSTED_RUNTIME_SHA256",
        ])
          overrides[name] = "";
      if (attack === "symlink-publisher") {
        overrides.TRUSTED_TAIL_PATH = join(file.dir, "linked-publisher.mjs");
        await symlink(file.publisher, overrides.TRUSTED_TAIL_PATH);
      }
      if (attack === "relative-publisher")
        overrides.TRUSTED_TAIL_PATH = "publisher.mjs";
      const result = await runStep(role, file, overrides);
      expect(result.exit).not.toBe(0);
      expect(await Bun.file(file.captured).exists()).toBe(false);
      expect(await Bun.file(file.sentinel).exists()).toBe(false);
    });
  },
);

describe("the judge step's script", () => {
  it("falls back to the step's own home and PATH when no review session ran", async () => {
    const file = await fixture();
    const result = await runStep("assess", file, {
      REVIEW_HOME: "",
      REVIEW_PATH: "",
    });
    expect(result.exit).toBe(0);
    const env = await capture(file);
    expect(env.RUNNER_HOME).toBe(file.dir);
    expect(env.RISK_JUDGE_PATH).toBe(file.poisoned);
  });
});

describe("the frozen risk programs", () => {
  let frozen: Record<string, string>;
  const forbidNetwork =
    'globalThis.fetch=()=>{console.error("NETWORK_FORBIDDEN");throw Error("NETWORK_FORBIDDEN")};\n';

  beforeAll(async () => {
    const helper = pathToFileURL(
      join(root, "src/prepare/review-runtime.ts"),
    ).href;
    const result = await child(
      [
        await realpath(process.execPath),
        "--config=/dev/null",
        "--env-file=/dev/null",
        "--eval",
        `const {freezeReviewRuntime}=await import(${JSON.stringify(helper)});console.log("__RISK_OUTPUTS__"+JSON.stringify(await freezeReviewRuntime(["risk_plan","risk_assess","risk_publish"])));`,
      ],
      directory,
      { PATH: "/usr/bin:/bin" },
    );
    const line = result.stdout
      .split("\n")
      .find((candidate) => candidate.startsWith("__RISK_OUTPUTS__"));
    if (!line) throw new Error(`Freeze did not complete: ${result.stderr}`);
    frozen = JSON.parse(line.slice("__RISK_OUTPUTS__".length));
  });
  afterAll(async () => {
    if (frozen)
      await rm(dirname(frozen.review_risk_plan_publisher_path!), {
        recursive: true,
        force: true,
      });
  });

  it("are frozen under the names the steps read, and importing one does not run it", async () => {
    const paths = (["plan", "assess", "publish"] as const).map((role) => {
      const path = frozen[`review_risk_${role}_publisher_path`]!;
      expect(path.startsWith("/")).toBe(true);
      return path;
    });
    for (const [index, role] of (
      ["plan", "assess", "publish"] as const
    ).entries())
      expect(hash(await readFile(paths[index]!))).toBe(
        frozen[`review_risk_${role}_publisher_sha256`]!,
      );
    const result = await child(
      [
        await realpath(process.execPath),
        "--config=/dev/null",
        "--env-file=/dev/null",
        "--eval",
        `${forbidNetwork}for(const path of ${JSON.stringify(paths)}){const module=await import(path);if(typeof module.run!=="function")throw Error("no run export");}console.log("all-imported");`,
      ],
      directory,
      { PATH: "/usr/bin:/bin" },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("all-imported");
    expect(result.exit).toBe(0);
  }, 60_000);

  it("the real plan step skips an event it does not assess without contacting the backend", async () => {
    const plan = await readFile(
      frozen.review_risk_plan_publisher_path!,
      "utf8",
    );
    const file = await fixture(
      `${forbidNetwork}${plan.replace(/^#![^\n]*\n/u, "")}`,
    );
    const result = await runStep("plan", file, {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "acme/widgets",
      RISK_EVENT_ACTION: "labeled",
      RISK_EVENT_PR_NUMBER: "7",
      RISK_EVENT_HEAD_REPO: "acme/widgets",
    });
    expect(result.stdout + result.stderr).not.toContain("NETWORK_FORBIDDEN");
    expect(result.exit).toBe(0);
    expect(stepOutputs(await readFile(file.outputs, "utf8"))).toEqual({
      action: "skip",
      reason: "event_not_assessed",
    });
  }, 60_000);

  it("the real plan step reports an error, and no plan, when the backend cannot be asked", async () => {
    const plan = await readFile(
      frozen.review_risk_plan_publisher_path!,
      "utf8",
    );
    const file = await fixture(
      `${forbidNetwork}${plan.replace(/^#![^\n]*\n/u, "")}`,
    );
    const result = await runStep("plan", file, {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "acme/widgets",
      RISK_EVENT_ACTION: "opened",
      RISK_EVENT_PR_NUMBER: "7",
      RISK_EVENT_HEAD_REPO: "acme/widgets",
      // Refused before any request is made.
      FACTORY_API_BASE_URL: "http://cleartext.invalid",
    });
    expect(result.exit).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("NETWORK_FORBIDDEN");
    expect(stepOutputs(await readFile(file.outputs, "utf8"))).toEqual({
      action: "error",
    });
  }, 60_000);
});
