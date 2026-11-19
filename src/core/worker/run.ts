import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Pin } from "./pins";
import { StepError, requiredEnv, writePrivateJson } from "./step";

const MAX_QUOTED_STDERR_CHARS = 1000;
/** How long the worker can take to stop a droid that ignores a stop. */
export const SESSION_STOP_SECONDS = 65;
/** The worker's git commands have no time limit of their own. */
export const EVIDENCE_SECONDS = 600;

/** How long a worker may run before it is asked to stop, and then killed. */
export type WorkerBounds = { stopAfterMs: number; killAfterMs: number };

/** Where the download step leaves a pinned file for the step that uses it. */
export function downloadedPath(
  pin: Pin,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(requiredEnv("WORKER_DIR", env), pin.name);
}

/**
 * The bytes the download step left for `pin`, when they are the ones its
 * digest names. This is the one place those bytes are checked, and what it
 * returns is what is used: a file changed after this read changes nothing.
 */
export async function readDownloaded(
  pin: Pin,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  const bytes = await readFile(downloadedPath(pin, env)).catch(() => {
    throw new StepError(
      "worker_unavailable",
      `The download step left no ${pin.name}`,
    );
  });
  if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) {
    throw new StepError(
      "worker_unavailable",
      `The downloaded ${pin.name} does not have the bytes this version pins`,
    );
  }
  return bytes;
}

/**
 * One session of a report, read for `started` when the session began. An
 * answer that broke the contract names the rules it broke, never the answer.
 */
export const sessionSchema = <Started extends z.ZodRawShape>(
  started: Started,
) =>
  z.union([
    z.object({ status: z.literal("failed"), problem: z.literal("start") }),
    z.object({
      ...started,
      status: z.literal("failed"),
      problem: z.enum(["execution", "permission"]),
    }),
    z.object({ ...started, status: z.literal("interrupted") }),
    z.object({
      ...started,
      status: z.literal("invalid"),
      issues: z.array(
        z.object({
          path: z.array(z.union([z.string(), z.number()])),
          code: z.string(),
        }),
      ),
    }),
    z.object({ ...started, status: z.literal("answered") }),
  ]);

/** A place in a JSON value, as a failure names it. */
export const pathName = (path: ReadonlyArray<string | number>) =>
  path.join(".") || "<root>";

/**
 * Runs `droid-review <product>` on a checkout that already holds the input's
 * commits, and returns the report it wrote, read by `report`. The worker is
 * the bytes `worker` holds, which the caller has checked, run under the
 * runtime this process runs under, with `env` as its whole environment.
 * Exit 0 and 1 are a report; anything else is a worker that left none,
 * whatever file may sit at the report's path. A worker that outlives every
 * bound it sets itself is asked to stop, which it answers with an
 * `interrupted` report, and then killed.
 */
export async function runWorker<Report>(options: {
  product: "risk" | "review";
  worker: Uint8Array;
  repoDir: string;
  input: unknown;
  env: NodeJS.ProcessEnv;
  bounds: WorkerBounds;
  report: z.ZodType<Report, z.ZodTypeDef, unknown>;
}): Promise<Report> {
  const dir = await mkdtemp(join(tmpdir(), "droid-review-worker-"));
  try {
    const workerPath = join(dir, "droid-review.mjs");
    const inputPath = join(dir, "input.json");
    const reportPath = join(dir, "report.json");
    await writeFile(workerPath, options.worker, { mode: 0o600 });
    await writePrivateJson(inputPath, options.input);

    const child = spawn(
      process.execPath,
      [
        "--config=/dev/null",
        "--env-file=/dev/null",
        "run",
        workerPath,
        options.product,
        "--repo",
        options.repoDir,
        "--input",
        inputPath,
        "--report",
        reportPath,
      ],
      { cwd: dir, env: options.env, stdio: ["ignore", "ignore", "pipe"] },
    );
    const { stopAfterMs, killAfterMs } = options.bounds;
    const stop = setTimeout(() => child.kill("SIGTERM"), stopAfterMs);
    const kill = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    // What the worker says about itself. A session's own output never
    // reaches it: the worker's SDK keeps that to itself.
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_QUOTED_STDERR_CHARS);
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => {
      clearTimeout(stop);
      clearTimeout(kill);
    });
    if (exitCode !== 0 && exitCode !== 1) {
      throw new StepError(
        "worker_no_report",
        `The droid-review worker left no report (exit ${exitCode}): ${stderr.trim()}`,
      );
    }
    // The report holds a model's answer, so a failure to read it names
    // paths and codes, never the parser's own message, which can quote it.
    const report = await readFile(reportPath, "utf8").then(JSON.parse, () => {
      throw new StepError(
        "worker_report_unreadable",
        "The droid-review worker's report could not be read",
      );
    });
    const parsed = options.report.safeParse(report);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${pathName(issue.path)}: ${issue.code}`)
        .join(", ");
      throw new StepError(
        "worker_report_unreadable",
        `The droid-review worker's report was not understood (${issues})`,
      );
    }
    return parsed.data;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
