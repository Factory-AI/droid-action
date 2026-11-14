import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  PrRiskEvidenceWorkspace,
  PullRequestRiskFile,
  PullRequestRiskInput,
  RiskJudge,
  RiskPlan,
} from "../../../src/core/risk/types";

const execFileAsync = promisify(execFile);

export const pullRequest: PullRequestRiskInput = {
  repo: "acme/app",
  prNumber: 123,
  title: "Rotate sessions safely",
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  additions: 430,
  deletions: 90,
  changedFiles: 1,
};

export function file(
  filename: string,
  additions = 10,
  deletions = 2,
): PullRequestRiskFile {
  return { filename, status: "modified", additions, deletions };
}

export function evidenceAt(rootDir: string): PrRiskEvidenceWorkspace {
  const evidenceDir = join(rootDir, "evidence");
  return {
    rootDir,
    headTreeDir: join(evidenceDir, "head"),
    diffPath: join(evidenceDir, "pr.diff"),
    inventoryPath: join(evidenceDir, "changed-files.json"),
    guidelinesPath: null,
    snapshotHash: "snapshot-hash",
  };
}

export const judge: RiskJudge = {
  group: "group-a",
  skill:
    "---\nname: pr-risk-judge\ndescription: Judge one PR.\n---\n\n# Custom skill\n\n{{PR_SNAPSHOT_JSON}}\n",
  enabledTools: ["Read", "Grep", "Task"],
  settings: {
    sessionDefaultSettings: { model: "test-model", reasoningEffort: "low" },
    subagentAutonomyLevel: "high",
  },
  scores: { blastRadius: [1, 5], testCoverage: [0, 3] },
  timeoutSeconds: 1,
  sha256: "c".repeat(64),
};

export const validVerdict = {
  verdict: true,
  brief: "- The changed path is directly covered.",
  details: "Read the test; it exercises the changed path.",
  scores: { blastRadius: 2, testCoverage: 3 },
};

/** The one JSON object `droid exec -o json` prints for a finished session. */
export function execSummary(result: unknown, sessionId = "session-1"): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: typeof result === "string" ? result : JSON.stringify(result),
    session_id: sessionId,
  });
}

export function planFor(overrides: Partial<RiskPlan> = {}): RiskPlan {
  return {
    repo: "acme/app",
    pr: 123,
    run: {
      runner: "droid-action",
      trigger: "pull_request",
      runId: "77",
      runAttempt: 2,
      dryRun: true,
    },
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    pullRequest: {
      title: "Rotate sessions safely",
      additions: 2,
      deletions: 1,
      changedFiles: 1,
    },
    priorDeclines: [],
    judge,
    ...overrides,
  };
}

/**
 * Runs git for a fixture repository with no host configuration, so a
 * developer's signing or hook setup cannot change what a test commits.
 */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
  return stdout.trim();
}

export async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** A bare `origin.git` whose HEAD names `defaultBranch`, and a clone of it. */
export async function createOriginAndCheckout(
  repoDir: string,
  defaultBranch = "dev",
): Promise<string> {
  await git(
    repoDir,
    "init",
    "-q",
    "--bare",
    `--initial-branch=${defaultBranch}`,
    "origin.git",
  );
  const checkoutDir = join(repoDir, "checkout");
  await git(repoDir, "clone", "-q", "origin.git", checkoutDir);
  return checkoutDir;
}
