import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  access,
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { freezeRiskSettle } from "../src/core/risk/freeze";
import { judge, planFor, validVerdict } from "./core/risk/fixtures";

type Step = {
  id?: string;
  name?: string;
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
type Received = {
  method: string;
  path: string;
  headers: Headers;
  body: string;
};

const root = join(import.meta.dir, "..");
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

// The settle and revoke steps run after the judge has run pull request code.
// These run the steps' own shell scripts from risk/action.yml against real
// frozen bundles, with a PATH that would betray any lookup through it.
describe("risk action tail steps", () => {
  let dir = "";
  let poisonedPath = "";
  let sentinel = "";
  let steps: Step[] = [];
  let settleBindings: Bindings;
  let revokeBindings: Bindings;
  const frozenDirs: string[] = [];
  const received: Received[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  let answer: () => Response = () => new Response(null, { status: 204 });

  const settleStep = () => stepNamed("Report to Factory");
  const revokeStep = () => stepNamed("Revoke judge read token");
  function stepNamed(name: string): Step {
    const found = steps.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`risk/action.yml has no step named ${name}`);
    return found;
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-risk-tail-test-"));
    steps = parse(await readFile(join(root, "risk", "action.yml"), "utf8")).runs
      .steps;

    sentinel = join(dir, "untrusted-code-ran");
    poisonedPath = join(dir, "poisoned-bin");
    await mkdir(poisonedPath);
    for (const name of ["bun", "env", "sha256sum", "shasum"]) {
      const path = join(poisonedPath, name);
      await writeFile(
        path,
        `#!/bin/sh\necho ${name} > '${sentinel}'\nexit 98\n`,
      );
      await chmod(path, 0o700);
    }

    const settle = await freezeRiskSettle();
    frozenDirs.push(dirname(settle.settlePath));
    settleBindings = {
      TRUSTED_TAIL_PATH: settle.settlePath,
      TRUSTED_TAIL_SHA256: settle.settleSha256,
      TRUSTED_RUNTIME_PATH: settle.runtimePath,
      TRUSTED_RUNTIME_SHA256: settle.runtimeSha256,
    };

    // The token step freezes the revoke script through the helper the other
    // actions share. It runs in its own process, as it does in the action.
    const helper = pathToFileURL(
      join(root, "src", "prepare", "review-runtime.ts"),
    ).href;
    const freeze = Bun.spawn(
      [
        process.execPath,
        "--config=/dev/null",
        "--env-file=/dev/null",
        "--eval",
        `const { freezeReviewRuntime } = await import(${JSON.stringify(helper)}); console.log("__FROZEN__" + JSON.stringify(await freezeReviewRuntime(["revoke"])));`,
      ],
      { cwd: dir, env: { PATH: "/usr/bin:/bin" }, stdout: "pipe" },
    );
    const frozenLine = (await new Response(freeze.stdout).text())
      .split("\n")
      .find((line) => line.startsWith("__FROZEN__"));
    if (!frozenLine) throw new Error("The revoke script could not be frozen");
    const revoke: Record<string, string | undefined> = JSON.parse(
      frozenLine.slice("__FROZEN__".length),
    );
    frozenDirs.push(dirname(revoke.review_revoke_publisher_path ?? ""));
    revokeBindings = {
      TRUSTED_TAIL_PATH: revoke.review_revoke_publisher_path ?? "",
      TRUSTED_TAIL_SHA256: revoke.review_revoke_publisher_sha256 ?? "",
      TRUSTED_RUNTIME_PATH: revoke.review_runtime_path ?? "",
      TRUSTED_RUNTIME_SHA256: revoke.review_runtime_sha256 ?? "",
    };

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push({
          method: request.method,
          path: new URL(request.url).pathname,
          headers: request.headers,
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
    for (const path of [dir, ...frozenDirs]) {
      if (path) await rm(path, { recursive: true, force: true });
    }
  });

  /** Runs one step's script the way the runner would, with only `env`. */
  async function runStep(step: Step, env: Record<string, string>) {
    const script = join(await mkdtemp(join(dir, "step-")), "step.sh");
    await writeFile(script, step.run);
    const cleared = Object.fromEntries(
      Object.entries(step.env).filter(([, value]) => value === ""),
    );
    const child = Bun.spawn([...step.shell.split(" ").slice(0, -1), script], {
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

  async function settleEnv(bindings: Bindings) {
    const work = await mkdtemp(join(dir, "work-"));
    const plan = planFor();
    const planPath = join(work, "plan.json");
    const resultPath = join(work, "result.json");
    const outputPath = join(work, "output");
    await writeFile(planPath, JSON.stringify(plan));
    await writeFile(
      resultPath,
      JSON.stringify({
        headSha: plan.headSha,
        result: {
          status: "judged",
          baseSha: plan.baseSha,
          judgeSha256: judge.sha256,
          snapshotHash: "f".repeat(64),
          listedFiles: 1,
          attempts: [{ sessionId: "s1", valid: true }],
          durationMs: 34,
          verdict: validVerdict,
        },
      }),
    );
    await writeFile(outputPath, "");
    return {
      outputPath,
      env: {
        ...bindings,
        FACTORY_API_KEY: "factory-key",
        RISK_API_BASE_URL: `http://127.0.0.1:${server?.port}`,
        RISK_PLAN_PATH: planPath,
        RISK_RESULT_PATH: resultPath,
        GITHUB_OUTPUT: outputPath,
        // Present in the job, and no business of the settle script.
        GITHUB_TOKEN: "workflow-token",
        ACTIONS_RUNTIME_TOKEN: "runtime-token",
      },
    };
  }

  it("settles through the frozen bundle and runtime, looking nothing up on PATH", async () => {
    answer = () => Response.json({ status: "published", outcome: "approve" });
    const { env, outputPath } = await settleEnv(settleBindings);

    const result = await runStep(settleStep(), env);

    expect(result.exit).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]?.path).toBe("/api/internal/pr-risk/settle");
    expect(received[0]?.headers.get("authorization")).toBe(
      "Bearer factory-key",
    );
    expect(JSON.parse(received[0]?.body ?? "")).toMatchObject({
      repo: "acme/app",
      pr: 123,
      result: { status: "judged", verdict: validVerdict },
    });
    expect(await readFile(outputPath, "utf8")).toMatch(
      /^outcome<<(\S+)\napprove\n\1\n$/,
    );
    expect(await exists(sentinel)).toBe(false);
  });

  it("fails the step when Factory could not be given a verdict", async () => {
    answer = () =>
      Response.json({ status: "published", outcome: "unavailable" });
    const { env } = await settleEnv(settleBindings);
    await rm(env.RISK_RESULT_PATH);

    const result = await runStep(settleStep(), env);

    expect(result.exit).toBe(1);
    expect(JSON.parse(received[0]?.body ?? "")).toMatchObject({
      result: { status: "failed", reason: "runner_died" },
    });
  });

  for (const tail of ["settle", "revoke"] as const) {
    const step = () => (tail === "settle" ? settleStep() : revokeStep());
    const bindings = () =>
      tail === "settle" ? settleBindings : revokeBindings;
    const tailEnv = async (trusted: Bindings) =>
      tail === "settle"
        ? (await settleEnv(trusted)).env
        : {
            ...trusted,
            GITHUB_TOKEN: "minted-read-token",
            GITHUB_API_URL: `http://127.0.0.1:${server?.port}`,
          };

    async function copyOf(path: string): Promise<string> {
      const copy = join(await mkdtemp(join(dir, "copy-")), "tail.mjs");
      await writeFile(copy, await readFile(path));
      return copy;
    }

    it(`refuses to ${tail} with a script that changed after it was frozen`, async () => {
      const changed = await copyOf(bindings().TRUSTED_TAIL_PATH);
      await appendFile(changed, "\n// edited after the judge started\n");

      const result = await runStep(
        step(),
        await tailEnv({ ...bindings(), TRUSTED_TAIL_PATH: changed }),
      );

      expect(result.exit).toBe(1);
      expect(result.stdout).toContain("refusing to execute");
      expect(received).toEqual([]);
      expect(await exists(sentinel)).toBe(false);
    });

    it(`refuses to ${tail} with a runtime that is not the one that froze it`, async () => {
      const result = await runStep(
        step(),
        await tailEnv({
          ...bindings(),
          TRUSTED_RUNTIME_SHA256: "0".repeat(64),
        }),
      );

      expect(result.exit).toBe(1);
      expect(result.stdout).toContain("refusing to execute");
      expect(received).toEqual([]);
    });

    it(`refuses to ${tail} through a symlink or without its bindings, and runs nothing else instead`, async () => {
      const link = join(await mkdtemp(join(dir, "link-")), "tail.mjs");
      await symlink(bindings().TRUSTED_TAIL_PATH, link);

      const linked = await runStep(
        step(),
        await tailEnv({ ...bindings(), TRUSTED_TAIL_PATH: link }),
      );
      const unbound = await runStep(
        step(),
        await tailEnv({
          TRUSTED_TAIL_PATH: "",
          TRUSTED_TAIL_SHA256: "",
          TRUSTED_RUNTIME_PATH: "",
          TRUSTED_RUNTIME_SHA256: "",
        }),
      );

      expect(linked.exit).toBe(1);
      expect(unbound.exit).toBe(1);
      expect(received).toEqual([]);
      expect(await exists(sentinel)).toBe(false);
    });
  }

  it("revokes the minted token through the frozen bundle with nothing else in its environment", async () => {
    answer = () => new Response(null, { status: 204 });

    const result = await runStep(revokeStep(), {
      ...revokeBindings,
      GITHUB_TOKEN: "minted-read-token",
      GITHUB_API_URL: `http://127.0.0.1:${server?.port}`,
      FACTORY_API_KEY: "factory-key",
    });

    expect(result.exit).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      method: "DELETE",
      path: "/installation/token",
    });
    expect(received[0]?.headers.get("authorization")).toBe(
      "Bearer minted-read-token",
    );
    expect(await exists(sentinel)).toBe(false);
  });
});
