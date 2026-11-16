import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./evidence";
import { describeFailure } from "./plan";
import type { PrRiskEvidenceWorkspace, RiskCheckRun } from "./types";
import type { PrRiskVerdict } from "./verdict";

/** Where a judge saves a script it wrote for a check, under the workspace root. */
export const CHECKS_DIR = join("evidence", "checks");
const CHECK_TIMEOUT_MS = 300_000;
const ALL_CHECKS_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 5_000;

export type RerunCitedChecksOptions = {
  repoDir: string;
  headSha: string;
  /** The judge's workspace, still on disk: its saved check scripts are copied. */
  evidence: PrRiskEvidenceWorkspace;
  checks: NonNullable<PrRiskVerdict["checks"]>;
  /** Paths changed since the prior head; a passing check covering one ends the run. */
  changedPaths: readonly string[];
  env?: NodeJS.ProcessEnv;
  checkTimeoutMs?: number;
  totalTimeoutMs?: number;
};

/**
 * Why a cited command is not run: it names a file outside the clean
 * workspace that the judge could have left behind, such as a scratch script
 * in the temp directory or the home directory. A script the judge wrote
 * counts only when it was saved under `evidence/checks/`, which is copied.
 */
export function rejectCheckCommand(
  command: string,
  homeDir: string = homedir(),
  tempDir: string = tmpdir(),
  workspaceDir?: string,
): string | undefined {
  const roots = [...new Set([tempDir, "/tmp", "/var/tmp", "/dev/shm", homeDir])]
    .filter((root) => root.length > 1)
    .map((root) => root.replace(/\/+$/u, ""));
  for (const token of command.split(/[\s"'`=;&|()<>]+/u)) {
    if (token.startsWith("~")) return "home_path";
    const under = (root: string) =>
      token === root || token.startsWith(`${root}/`);
    if (workspaceDir && under(workspaceDir)) continue;
    if (roots.some(under)) {
      return "outside_path";
    }
  }
  return undefined;
}

/**
 * The environment a re-run check gets: enough to find tools and caches, and
 * none of the job's credentials, so a check cannot reach more than the
 * judge's session could.
 */
function checkEnvironment(
  source: NodeJS.ProcessEnv,
  tempDir: string,
): NodeJS.ProcessEnv {
  return {
    ...(source.PATH ? { PATH: source.PATH } : {}),
    ...(source.HOME ? { HOME: source.HOME } : {}),
    ...(source.LANG ? { LANG: source.LANG } : {}),
    TMPDIR: tempDir,
    CI: "true",
  };
}

function runOne(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["--noprofile", "--norc", "-c", command], {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
    });
    let timedOut = false;
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // A check that leaves a server or watcher behind must not outlive it.
      killGroup("SIGKILL");
      resolve({ exitCode: timedOut ? null : code, timedOut });
    });
  });
}

/**
 * Runs the checks a re-check cited again, in a clean workspace laid out like
 * the judge's: a fresh worktree of the head at `evidence/head`, and the
 * scripts the judge saved at `evidence/checks`. Factory decides from these
 * exit codes only, never from the ones the judge reported. Checks run in the
 * order cited, and stop at the first that passes and covers a changed path.
 * Output is discarded: it is pull request code's, and only the exit code is
 * evidence. Never throws: a workspace that cannot be built leaves every
 * check unrun.
 */
export async function rerunCitedChecks(
  options: RerunCitedChecksOptions,
): Promise<RiskCheckRun[]> {
  const env = options.env ?? process.env;
  const checkTimeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  const deadline =
    Date.now() + (options.totalTimeoutMs ?? ALL_CHECKS_TIMEOUT_MS);
  const changed = new Set(options.changedPaths);
  const runs: RiskCheckRun[] = [];
  let rootDir: string | undefined;
  let headTreeDir: string | undefined;
  try {
    rootDir = await realpath(await mkdtemp(join(tmpdir(), "pr-risk-checks-")));
    const workspace = rootDir;
    const tempDir = join(workspace, "tmp");
    await mkdir(join(workspace, "evidence"), { recursive: true });
    await mkdir(tempDir);
    // Everything but the head checkout: a saved script may read the diff,
    // the interdiff, or the focus list beside it. The scripts are the
    // judge's own, so a file it edited there gives it nothing it lacked.
    const evidenceDir = join(options.evidence.rootDir, "evidence");
    for (const entry of await readdir(evidenceDir)) {
      if (entry === "head") continue;
      await cp(join(evidenceDir, entry), join(workspace, "evidence", entry), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    headTreeDir = join(workspace, "evidence", "head");
    await git(["worktree", "add", "--detach", headTreeDir, options.headSha], {
      cwd: options.repoDir,
    });
    const childEnv = checkEnvironment(env, tempDir);
    for (const [index, check] of options.checks.entries()) {
      // The judge ran from its own workspace root; the same paths name the
      // same files here.
      const command = check.command
        .split(options.evidence.rootDir)
        .join(workspace);
      const rejected = rejectCheckCommand(
        command,
        env.HOME,
        tmpdir(),
        workspace,
      );
      if (rejected) {
        runs.push({ index, outcome: "rejected", reason: rejected });
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        runs.push({ index, outcome: "skipped", reason: "time_budget" });
        continue;
      }
      const startedAt = Date.now();
      const { exitCode, timedOut } = await runOne(
        command,
        workspace,
        childEnv,
        Math.min(checkTimeoutMs, remaining),
      );
      const durationMs = Date.now() - startedAt;
      runs.push(
        timedOut
          ? { index, outcome: "timed_out", durationMs }
          : exitCode === null
            ? { index, outcome: "failed_to_start", durationMs }
            : { index, outcome: "ran", exitCode, durationMs },
      );
      console.log(
        `PR risk check ${index + 1} of ${options.checks.length}: ${
          timedOut ? "timed out" : `exit ${exitCode ?? "none"}`
        } in ${(durationMs / 1000).toFixed(1)}s`,
      );
      if (
        exitCode === 0 &&
        !timedOut &&
        check.covers.some((path) => changed.has(path.replace(/^\.\//u, "")))
      ) {
        break;
      }
    }
  } catch (error) {
    console.warn(
      `PR risk cited checks could not be re-run: ${describeFailure(error)}`,
    );
    const ran = new Set(runs.map(({ index }) => index));
    for (const index of options.checks.keys()) {
      if (!ran.has(index)) {
        runs.push({ index, outcome: "skipped", reason: "workspace_failed" });
      }
    }
  } finally {
    if (headTreeDir) {
      await git(["worktree", "remove", "--force", headTreeDir], {
        cwd: options.repoDir,
      }).catch(() => undefined);
    }
    if (rootDir) {
      await rm(rootDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      }).catch(() => undefined);
    }
  }
  return runs;
}
