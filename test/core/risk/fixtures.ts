import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RiskJudge, RiskPlan } from "../../../src/core/risk/types";

const execFileAsync = promisify(execFile);

type RiskIncremental = NonNullable<RiskPlan["incremental"]>;

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
    pullRequest: { title: "Rotate sessions safely" },
    priorDeclines: [],
    judge,
    ...overrides,
  };
}

/** An earlier verdict to re-check, as Factory's `begin` serves one. */
export function incrementalFor(
  overrides: Partial<RiskIncremental> = {},
): RiskIncremental {
  return {
    mode: "enforce",
    reason: "small_change_since_decline",
    priorHeadSha: "1".repeat(40),
    priorAssessmentId: "0b9f6f0e-4c1d-4a55-9d2e-6a1f0c3b7e21",
    priorBaseSha: "2".repeat(40),
    judgeSha256: "9".repeat(64),
    prior: {
      verdict: false,
      outcome: "doNotApprove",
      brief: "- The rotation is untested.",
      details: "No test exercises the rotation.",
      concerns: [{ id: "c1", text: "The rotation is untested." }],
    },
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

/**
 * An origin with pull request 123 and a clone of it. Three commits leave one
 * fork point: the pull request's head, the tip of its base branch `release`,
 * and the tip of the default branch `dev`.
 */
export async function checkoutWithPullRequest(repoDir: string) {
  const checkoutDir = await createOriginAndCheckout(repoDir);
  await writeFile(join(checkoutDir, "app.ts"), "export const old = 1;\n");
  const forkSha = await commit(checkoutDir, "fork point");
  await writeFile(join(checkoutDir, "feature.ts"), "export const f = 1;\n");
  const headSha = await commit(checkoutDir, "head");
  await git(checkoutDir, "checkout", "-q", forkSha);
  await writeFile(join(checkoutDir, "base-only.ts"), "export {};\n");
  const baseSha = await commit(checkoutDir, "base tip");
  await git(checkoutDir, "checkout", "-q", forkSha);
  await writeFile(join(checkoutDir, "default-only.ts"), "export {};\n");
  const policySha = await commit(checkoutDir, "default branch tip");
  // The head and base an earlier verdict judged, both since replaced: the
  // remote still has them, and no branch or pull request leads to them.
  await git(checkoutDir, "checkout", "-q", forkSha);
  await writeFile(join(checkoutDir, "feature.ts"), "export const f = 0;\n");
  const priorHeadSha = await commit(checkoutDir, "earlier head");
  await git(checkoutDir, "checkout", "-q", forkSha);
  await writeFile(join(checkoutDir, "base-earlier.ts"), "export {};\n");
  const priorBaseSha = await commit(checkoutDir, "earlier base tip");
  await git(
    checkoutDir,
    "push",
    "-q",
    "origin",
    `${policySha}:refs/heads/dev`,
    `${baseSha}:refs/heads/release`,
    `${headSha}:refs/pull/123/head`,
    `${priorHeadSha}:refs/replaced/head`,
    `${priorBaseSha}:refs/replaced/base`,
  );
  return {
    checkoutDir,
    originDir: join(repoDir, "origin.git"),
    forkSha,
    headSha,
    baseSha,
    policySha,
    priorHeadSha,
    priorBaseSha,
  };
}

/** What a stand-in worker does once it has recorded how it was run. */
export type WorkerScript = {
  recordPath: string;
  /** Left at the report's path when set. */
  report?: unknown;
  exitCode: number;
  stderr?: string;
  /** Keeps running until asked to stop, or through that until killed. */
  until?: "asked" | "killed";
};

/** How a stand-in worker was run, as it saw it. */
export type WorkerRun = {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  input: unknown;
  /** The checkout's git configuration when the worker started. */
  repoConfig: string;
};

/** A stand-in for the `droid-review` worker, and the digest of its bytes. */
export function standInWorker(script: WorkerScript): {
  source: string;
  sha256: string;
} {
  const source = `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const script = ${JSON.stringify(script)};
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const end = () => {
  if (script.report !== undefined) {
    writeFileSync(flag("--report"), JSON.stringify(script.report));
  }
  process.stderr.write(script.stderr ?? "");
  process.exit(script.exitCode);
};
if (script.until) {
  process.on("SIGTERM", script.until === "asked" ? end : () => {});
  setInterval(() => {}, 1000);
}
writeFileSync(
  script.recordPath,
  JSON.stringify({
    args,
    env: process.env,
    cwd: process.cwd(),
    input: JSON.parse(readFileSync(flag("--input"), "utf8")),
    repoConfig: readFileSync(join(flag("--repo"), ".git", "config"), "utf8"),
  }),
);
if (!script.until) end();
`;
  return { source, sha256: createHash("sha256").update(source).digest("hex") };
}

/**
 * Publishes `source` the way GitHub publishes the real worker: an address
 * that answers only a request for the file's bytes that holds `token`, by
 * redirecting to storage on another origin. `forwarded` holds every
 * Authorization header the storage was sent.
 */
export function serveWorker(source: string): {
  url: string;
  token: string;
  forwarded: string[];
  stop: () => Promise<void>;
} {
  const token = "worker-token";
  const forwarded: string[] = [];
  const storage = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const authorization = request.headers.get("authorization");
      if (authorization) forwarded.push(authorization);
      return new Response(source);
    },
  });
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const asked =
        request.headers.get("authorization") === `Bearer ${token}` &&
        request.headers.get("accept") === "application/octet-stream";
      return asked
        ? Response.redirect(`http://127.0.0.1:${storage.port}/droid-review.mjs`)
        : new Response("Not Found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${api.port}/releases/assets/1`,
    token,
    forwarded,
    stop: async () => {
      await api.stop(true);
      await storage.stop(true);
    },
  };
}
