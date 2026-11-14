import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  access,
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { planFor } from "./core/risk/fixtures";

type Step = {
  id?: string;
  shell: string;
  run: string;
  env: Record<string, string>;
};
type Bindings = {
  TRUSTED_TAIL_PATH: string;
  TRUSTED_TAIL_SHA256: string;
  TRUSTED_RUNTIME_PATH: string;
  TRUSTED_RUNTIME_SHA256: string;
};

const root = join(import.meta.dir, "..");
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

// In the full action the risk steps start after the review's model session
// has run with the pull request checked out. These run the steps' own shell
// scripts from action.yml against bundles frozen the way the prepare step
// freezes them, with a PATH that would betray any lookup through it.
describe("full action risk steps before the judge", () => {
  let dir = "";
  let poisonedPath = "";
  let sentinel = "";
  let steps: Step[] = [];
  let frozen: Record<string, string | undefined> = {};
  const received: { path: string; body: string }[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  let answer: () => Response = () => new Response(null, { status: 204 });

  function step(id: string): Step {
    const found = steps.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`action.yml has no step with id ${id}`);
    return found;
  }
  const bindingsFor = (kind: string): Bindings => ({
    TRUSTED_TAIL_PATH: frozen[`review_${kind}_publisher_path`] ?? "",
    TRUSTED_TAIL_SHA256: frozen[`review_${kind}_publisher_sha256`] ?? "",
    TRUSTED_RUNTIME_PATH: frozen.review_runtime_path ?? "",
    TRUSTED_RUNTIME_SHA256: frozen.review_runtime_sha256 ?? "",
  });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-risk-bundled-test-"));
    steps = parse(await readFile(join(root, "action.yml"), "utf8")).runs.steps;

    sentinel = join(dir, "untrusted-code-ran");
    poisonedPath = join(dir, "poisoned-bin");
    await mkdir(poisonedPath);
    for (const name of ["bun", "env", "sha256sum", "shasum", "tr", "printf"]) {
      const path = join(poisonedPath, name);
      await writeFile(
        path,
        `#!/bin/sh\necho ${name} > '${sentinel}'\nexit 98\n`,
      );
      await chmod(path, 0o700);
    }

    const helper = pathToFileURL(
      join(root, "src", "prepare", "review-runtime.ts"),
    ).href;
    const freeze = Bun.spawn(
      [
        process.execPath,
        "--config=/dev/null",
        "--env-file=/dev/null",
        "--eval",
        `const { freezeReviewRuntime, RISK_RUNTIME_KINDS } = await import(${JSON.stringify(helper)}); console.log("__FROZEN__" + JSON.stringify(await freezeReviewRuntime(RISK_RUNTIME_KINDS)));`,
      ],
      { cwd: dir, env: { PATH: "/usr/bin:/bin" }, stdout: "pipe" },
    );
    const frozenLine = (await new Response(freeze.stdout).text())
      .split("\n")
      .find((line) => line.startsWith("__FROZEN__"));
    if (!frozenLine) throw new Error("The risk scripts could not be frozen");
    frozen = JSON.parse(frozenLine.slice("__FROZEN__".length));

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push({
          path: new URL(request.url).pathname,
          body: await request.text(),
        });
        return answer();
      },
    });
  });

  afterEach(async () => {
    received.length = 0;
    await rm(sentinel, { force: true });
  });

  afterAll(async () => {
    await server?.stop(true);
    const frozenDir = frozen.review_settle_publisher_path;
    for (const path of [dir, frozenDir ? dirname(frozenDir) : ""]) {
      if (path) await rm(path, { recursive: true, force: true });
    }
  });

  /** Runs one step's script the way the runner would, with only `env`. */
  async function runStep(target: Step, env: Record<string, string>) {
    const script = join(await mkdtemp(join(dir, "step-")), "step.sh");
    await writeFile(script, target.run);
    const cleared = Object.fromEntries(
      Object.entries(target.env).filter(([, value]) => value === ""),
    );
    const child = Bun.spawn([...target.shell.split(" ").slice(0, -1), script], {
      cwd: dir,
      env: { ...cleared, PATH: poisonedPath, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exit };
  }

  async function beginEnv(bindings: Bindings) {
    const work = await mkdtemp(join(dir, "work-"));
    const outputPath = join(work, "output");
    await writeFile(outputPath, "");
    return {
      outputPath,
      planPath: join(work, "pr-risk", "plan.json"),
      env: {
        ...bindings,
        FACTORY_API_KEY: "factory-key",
        RISK_API_BASE_URL: `http://127.0.0.1:${server?.port}`,
        RISK_PR_NUMBER: "123",
        RISK_REVIEW_OUTCOME: "failure",
        RISK_DRY_RUN: "true",
        RISK_MANUAL: "false",
        RISK_PLAN_PATH: join(work, "pr-risk", "plan.json"),
        RISK_RESULT_PATH: join(work, "pr-risk", "result.json"),
        RUNNER_TEMP: work,
        GITHUB_REPOSITORY: "acme/app",
        GITHUB_OUTPUT: outputPath,
        // Present in the job, and no business of the begin script.
        GITHUB_TOKEN: "workflow-token",
      },
    };
  }

  it("freezes a bundle for every script the risk steps run", () => {
    for (const kind of ["risk_begin", "risk_token", "risk_assess", "settle"]) {
      expect(frozen[`review_${kind}_publisher_path`]).toMatch(/^\//);
      expect(frozen[`review_${kind}_publisher_sha256`]).toMatch(
        /^[a-f0-9]{64}$/,
      );
    }
  });

  it("asks Factory through the frozen bundle and runtime, looking nothing up on PATH", async () => {
    const { repo: _repo, pr: _pr, run: _run, ...assignment } = planFor();
    answer = () => Response.json({ action: "judge", ...assignment });
    const { env, outputPath, planPath } = await beginEnv(
      bindingsFor("risk_begin"),
    );

    const result = await runStep(step("risk_begin"), env);

    expect({ exit: result.exit, stderr: result.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.path).toBe("/api/internal/pr-risk/begin");
    expect(JSON.parse(received[0]?.body ?? "")).toMatchObject({
      repo: "acme/app",
      pr: 123,
      reviewOutcome: "failure",
    });
    const output = await readFile(outputPath, "utf8");
    expect(output).toMatch(/^action<<(\S+)\njudge\n\1\n/);
    // The settle script was frozen before the review; a frozen copy of the
    // begin script has no source to freeze it from again.
    expect(output).not.toContain("review_settle_publisher_path");
    expect(await exists(planPath)).toBe(true);
    expect(await exists(sentinel)).toBe(false);
  });

  for (const id of ["risk_begin", "risk_token", "risk_assess"]) {
    it(`refuses to run ${id} from a script that changed after it was frozen`, async () => {
      const changed = join(await mkdtemp(join(dir, "copy-")), "tail.mjs");
      await writeFile(
        changed,
        await readFile(bindingsFor(id).TRUSTED_TAIL_PATH),
      );
      await appendFile(changed, "\n// edited while the review ran\n");
      const { env } = await beginEnv({
        ...bindingsFor(id),
        TRUSTED_TAIL_PATH: changed,
      });

      const result = await runStep(step(id), { ...env, RISK_DRY_RUN: "false" });

      expect(result.exit).toBe(1);
      expect(result.stdout).toContain("refusing to execute");
      expect(received).toEqual([]);
      expect(await exists(sentinel)).toBe(false);
    });

    it(`refuses to run ${id} when the prepare step froze nothing`, async () => {
      const { env } = await beginEnv({
        TRUSTED_TAIL_PATH: "",
        TRUSTED_TAIL_SHA256: "",
        TRUSTED_RUNTIME_PATH: "",
        TRUSTED_RUNTIME_SHA256: "",
      });

      const result = await runStep(step(id), { ...env, RISK_DRY_RUN: "false" });

      expect(result.exit).toBe(1);
      expect(result.stdout).toContain("no mutable fallback will run");
      expect(received).toEqual([]);
      expect(await exists(sentinel)).toBe(false);
    });
  }

  it("lets a dry run without OIDC read with the workflow token, running nothing", async () => {
    const work = await mkdtemp(join(dir, "work-"));
    const outputPath = join(work, "output");
    await writeFile(outputPath, "");

    const result = await runStep(step("risk_token"), {
      RISK_DRY_RUN: "True",
      GITHUB_OUTPUT: outputPath,
    });

    expect(result.exit).toBe(0);
    expect(await readFile(outputPath, "utf8")).toBe(
      "use_workflow_token=true\n",
    );
    expect(await exists(sentinel)).toBe(false);
  });
});
