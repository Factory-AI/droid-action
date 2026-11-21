import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  readDownloaded,
  runWorker,
  type WorkerBounds,
} from "../../../src/core/worker/run";
import {
  git,
  standInWorker,
  type WorkerRun,
  type WorkerScript,
} from "./fixtures";

describe("runWorker", () => {
  let dir = "";
  let recordPath = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "droid-worker-run-test-"));
    recordPath = join(dir, "worker-run.json");
    await git(dir, "init", "-q");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function run(script: Omit<WorkerScript, "recordPath">, bounds: WorkerBounds) {
    return runWorker({
      product: "review",
      worker: Buffer.from(standInWorker({ ...script, recordPath }).source),
      repoDir: dir,
      input: { pr: 123 },
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      bounds,
      report: z.object({ status: z.string(), by: z.string() }),
    });
  }

  it("asks a worker that outlives its bounds to stop, and takes the report it then leaves", async () => {
    const report = await run(
      {
        until: "asked",
        exitCode: 1,
        report: { status: "interrupted", by: "signal" },
      },
      { stopAfterMs: 2_000, killAfterMs: 60_000 },
    );

    expect(report).toEqual({ status: "interrupted", by: "signal" });
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
    expect(ran.args[0]).toBe("review");
  }, 30_000);
});

describe("readDownloaded", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "droid-worker-read-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the bytes it checked, from one read of the file", async () => {
    const bytes = Buffer.from("the pinned bytes");
    const pin = {
      name: "pinned",
      url: "",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    // A pipe gives what was written to it to one read, and nothing to a
    // second.
    await promisify(execFile)("mkfifo", [join(dir, pin.name)]);
    const written = writeFile(join(dir, pin.name), bytes);

    expect(await readDownloaded(pin, { WORKER_DIR: dir })).toEqual(bytes);
    await written;
  });
});
