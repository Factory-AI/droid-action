import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rejectCheckCommand,
  rerunCitedChecks,
} from "../../../src/core/risk/checks";
import { commit, createOriginAndCheckout, evidenceAt, git } from "./fixtures";

describe("rejectCheckCommand", () => {
  it.each([
    ["npx vitest run src/a.test.ts"],
    ["cd evidence/head && bun test test/a.test.ts"],
    ["node evidence/checks/probe.mjs"],
    ["/usr/bin/env node --version"],
  ])("runs %s", (command) => {
    expect(rejectCheckCommand(command, "/home/runner", "/tmp")).toBeUndefined();
  });

  it.each([
    ["node /tmp/probe.mjs", "outside_path"],
    ["bash -c 'node /var/tmp/x.js'", "outside_path"],
    ["node /home/runner/scratch.js", "outside_path"],
    ["node ~/scratch.js", "home_path"],
    ["FILE=/tmp/x node a.js", "outside_path"],
  ])("refuses %s", (command, reason) => {
    expect(rejectCheckCommand(command, "/home/runner", "/tmp")).toBe(reason);
  });
});

describe("rerunCitedChecks", () => {
  let repoDir = "";
  let checkoutDir = "";
  let headSha = "";
  let judgeRoot = "";

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "pr-risk-rerun-repo-"));
    checkoutDir = await createOriginAndCheckout(repoDir);
    await writeFile(join(checkoutDir, "app.ts"), "export const next = 1;\n");
    headSha = await commit(checkoutDir, "head");
    // The judge's workspace: its head tree carries an edit the judge made,
    // and it saved one script for a check.
    judgeRoot = await mkdtemp(join(tmpdir(), "pr-risk-judge-root-"));
    await mkdir(join(judgeRoot, "evidence", "head"), { recursive: true });
    await writeFile(join(judgeRoot, "evidence", "head", "planted.txt"), "x");
    await mkdir(join(judgeRoot, "evidence", "checks"));
    await writeFile(
      join(judgeRoot, "evidence", "checks", "probe.sh"),
      'grep -q "next" evidence/head/app.ts\n',
    );
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(judgeRoot, { recursive: true, force: true });
  });

  const run = (
    checks: { command: string; exitCode: number; covers: string[] }[],
    overrides: { checkTimeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
  ) =>
    rerunCitedChecks({
      repoDir: checkoutDir,
      headSha,
      evidence: evidenceAt(judgeRoot),
      checks,
      changedPaths: ["app.ts"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      ...overrides,
    });

  it("runs each check in a fresh head tree with the saved scripts, and reports its own exit codes", async () => {
    const runs = await run([
      // The judge's edit is not in the clean tree, whatever it reported.
      {
        command: "test -f evidence/head/planted.txt",
        exitCode: 0,
        covers: ["app.ts"],
      },
      { command: "bash evidence/checks/probe.sh", exitCode: 1, covers: [] },
      {
        command: `test -f ${judgeRoot}/evidence/head/app.ts`,
        exitCode: 0,
        covers: ["app.ts"],
      },
      { command: "true", exitCode: 0, covers: ["app.ts"] },
    ]);

    expect(runs).toEqual([
      { index: 0, outcome: "ran", exitCode: 1, durationMs: expect.any(Number) },
      { index: 1, outcome: "ran", exitCode: 0, durationMs: expect.any(Number) },
      { index: 2, outcome: "ran", exitCode: 0, durationMs: expect.any(Number) },
    ]);
    expect(
      (await git(checkoutDir, "worktree", "list", "--porcelain")).match(
        /^worktree /gmu,
      ),
    ).toHaveLength(1);
  });

  it("keeps the job's credentials out of a check", async () => {
    const [first] = await run(
      [
        {
          command: 'test -z "$FACTORY_API_KEY$GH_TOKEN"',
          exitCode: 0,
          covers: ["app.ts"],
        },
      ],
      {
        env: {
          PATH: process.env.PATH,
          FACTORY_API_KEY: "factory-key",
          GH_TOKEN: "gh-token",
        },
      },
    );
    expect(first).toMatchObject({ outcome: "ran", exitCode: 0 });
  });

  it("refuses a script left outside the workspace and stops a check at its time limit", async () => {
    const runs = await run(
      [
        { command: "node /tmp/probe.mjs", exitCode: 0, covers: ["app.ts"] },
        { command: "sleep 30", exitCode: 0, covers: ["app.ts"] },
      ],
      { checkTimeoutMs: 300 },
    );
    expect(runs).toEqual([
      { index: 0, outcome: "rejected", reason: "outside_path" },
      { index: 1, outcome: "timed_out", durationMs: expect.any(Number) },
    ]);
    expect(runs[1]?.durationMs).toBeLessThan(10_000);
  });

  it("leaves every check unrun when the head cannot be checked out", async () => {
    const runs = await rerunCitedChecks({
      repoDir: checkoutDir,
      headSha: "d".repeat(40),
      evidence: evidenceAt(judgeRoot),
      checks: [{ command: "true", exitCode: 0, covers: ["app.ts"] }],
      changedPaths: ["app.ts"],
      env: { PATH: process.env.PATH },
    });
    expect(runs).toEqual([
      { index: 0, outcome: "skipped", reason: "workspace_failed" },
    ]);
  });
});
