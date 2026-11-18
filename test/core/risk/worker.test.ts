import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkerInput, runRiskWorker } from "../../../src/core/risk/worker";
import {
  git,
  planFor,
  serveWorker,
  type WorkerRun,
  type WorkerScript,
} from "./fixtures";

describe("runRiskWorker", () => {
  let dir = "";
  let recordPath = "";
  let served: ReturnType<typeof serveWorker> | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-risk-worker-test-"));
    recordPath = join(dir, "worker-run.json");
    await git(dir, "init", "-q");
  });

  afterEach(async () => {
    await served?.stop();
    served = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  function run(
    script: Omit<WorkerScript, "recordPath">,
    bounds: { stopAfterMs: number; killAfterMs: number },
  ) {
    served = serveWorker({ ...script, recordPath });
    return runRiskWorker({
      worker: served.worker,
      workerToken: served.token,
      repoDir: dir,
      input: buildWorkerInput(planFor(), "d".repeat(40)),
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      bounds,
    });
  }

  it("asks a worker that outlives its bounds to stop, and takes the report it then leaves", async () => {
    const report = await run(
      {
        until: "asked",
        exitCode: 1,
        report: {
          product: "risk",
          worker: { droid: "9.9.9" },
          revision: { base: "b".repeat(40), head: "a".repeat(40) },
          sessions: [],
          status: "interrupted",
          by: "signal",
        },
      },
      { stopAfterMs: 2_000, killAfterMs: 60_000 },
    );

    expect(report).toMatchObject({ status: "interrupted", by: "signal" });
  }, 30_000);

  it("kills a worker that keeps running after it was asked to stop", async () => {
    await expect(
      run(
        { until: "killed", exitCode: 0 },
        { stopAfterMs: 2_000, killAfterMs: 3_000 },
      ),
    ).rejects.toMatchObject({ reason: "worker_no_report" });

    // It had started, and was still running when it was killed.
    const ran: WorkerRun = JSON.parse(await readFile(recordPath, "utf8"));
    expect(ran.args[0]).toBe("risk");
  }, 30_000);
});
