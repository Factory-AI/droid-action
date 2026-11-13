import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GITHUB_SERVER_URL } from "../../github/api/config";
import {
  RISK_JUDGE_SKILL_NAME,
  RiskError,
  type PrRiskEvidenceWorkspace,
  type PullRequestRiskSnapshot,
} from "./types";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const GUIDELINES_REPO_PATH = ".factory/pr-risk/guidelines.md";
// Retries cover files that appear while a directory is being emptied.
const REMOVE_WORKSPACE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 200,
} as const;

type GitRepo = { cwd: string; githubToken?: string };

/**
 * The environment every evidence git command runs in: an allow-list, so no
 * credential of the job reaches git, plus the token as a request header for
 * this one command.
 */
export function gitEnvironment(
  githubToken?: string,
  source: NodeJS.ProcessEnv = process.env,
  serverUrl: string = GITHUB_SERVER_URL,
): NodeJS.ProcessEnv {
  const header = `http.${serverUrl}/.extraheader`;
  return {
    ...(source.PATH ? { PATH: source.PATH } : {}),
    ...(source.HOME ? { HOME: source.HOME } : {}),
    ...(source.TMPDIR ? { TMPDIR: source.TMPDIR } : {}),
    ...(githubToken
      ? {
          // actions/checkout leaves its own Authorization header in the
          // clone's config, and GitHub rejects a request carrying two. The
          // empty value clears every header set before it.
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: header,
          GIT_CONFIG_VALUE_0: "",
          GIT_CONFIG_KEY_1: header,
          GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(
            `x-access-token:${githubToken}`,
          ).toString("base64")}`,
        }
      : {}),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
  };
}

/**
 * Runs one git command against the repository and returns its trimmed stdout.
 * Only the repository's own configuration applies: host-level config,
 * attributes, and hooks cannot change what a head checks out as, so the same
 * commit yields the same evidence on every machine.
 */
async function git(args: readonly string[], repo: GitRepo): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "core.hooksPath=/dev/null", ...args],
      {
        cwd: repo.cwd,
        env: gitEnvironment(repo.githubToken),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    return stdout.trim();
  } catch (error) {
    // The token travels in the environment, so neither the command line nor
    // git's own message in this error carries it.
    throw new RiskError(
      "evidence_git_failed",
      error instanceof Error ? error.message : "git failed",
      { cause: error },
    );
  }
}

/**
 * Resolves the current tip of the remote's default branch. Guidelines come
 * from there rather than from the pull request's base commit, because a base
 * can be a branch its author controls (a stacked or retargeted pull request)
 * and GitHub's recorded base commit can lag behind the branch.
 */
async function resolveDefaultBranchTip(repo: GitRepo): Promise<string> {
  const output = await git(["ls-remote", "--symref", "origin", "HEAD"], repo);
  const branch = /^ref: refs\/heads\/\S+\tHEAD$/m.test(output);
  const tip = /^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/m.exec(output)?.[1];
  if (!branch || !tip) {
    throw new RiskError(
      "pr_risk_default_branch_unresolved",
      "PR risk could not resolve the default branch",
    );
  }
  return tip;
}

/**
 * Reads the repository's PR risk guidelines from one verified commit on the
 * default branch. The pull request's own commits are never read, so a pull
 * request cannot rewrite the policy it is judged against. Returns null when
 * that commit has no such file or it is empty.
 */
async function readGuidelines(
  commit: string,
  repo: GitRepo,
): Promise<string | null> {
  const entry = await git(
    ["ls-tree", commit, "--", GUIDELINES_REPO_PATH],
    repo,
  );
  if (!entry) return null;
  const [mode, type] = entry.split(/\s/);
  if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
    throw new RiskError(
      "pr_risk_guidelines_invalid",
      "PR risk guidelines are not a regular file",
    );
  }
  const guidelines = await git(
    ["cat-file", "blob", `${commit}:${GUIDELINES_REPO_PATH}`],
    repo,
  );
  return guidelines || null;
}

/**
 * Creates the evidence workspace a judge reads: the merge-base diff written
 * straight to disk, the changed-file inventory, the default branch's PR risk
 * guidelines when it has them, and the exact head checked out as a detached
 * worktree. The worktree's `.git` is a pointer file into the repository, so
 * git commands run inside it (history, blame) resolve against the caller's
 * checkout. The base revision is used only to compute the diff and is not
 * named to the model.
 */
export async function createPrRiskEvidenceWorkspace(
  snapshot: PullRequestRiskSnapshot,
  options: { repoDir: string; githubToken: string },
): Promise<PrRiskEvidenceWorkspace> {
  const { baseSha, headSha, prNumber } = snapshot.pullRequest;
  const repo = { cwd: options.repoDir, githubToken: options.githubToken };
  const guidelinesSha = await resolveDefaultBranchTip(repo);
  // actions/checkout clones one commit deep by default, and a merge base
  // cannot be found across a shallow boundary.
  const shallow =
    (await git(["rev-parse", "--is-shallow-repository"], repo)) === "true";
  await git(
    [
      "fetch",
      "--no-tags",
      ...(shallow ? ["--unshallow"] : []),
      "origin",
      baseSha,
      `refs/pull/${prNumber}/head`,
      guidelinesSha,
    ],
    repo,
  );
  const resolvedBase = await git(
    ["rev-parse", "--verify", `${baseSha}^{commit}`],
    repo,
  );
  const resolvedHead = await git(
    ["rev-parse", "--verify", `${headSha}^{commit}`],
    repo,
  );
  const resolvedGuidelines = await git(
    ["rev-parse", "--verify", `${guidelinesSha}^{commit}`],
    repo,
  );
  if (
    resolvedBase !== baseSha ||
    resolvedHead !== headSha ||
    resolvedGuidelines !== guidelinesSha
  ) {
    throw new RiskError(
      "pr_risk_revision_mismatch",
      "PR risk revisions did not resolve exactly",
    );
  }
  const mergeBase = await git(["merge-base", baseSha, headSha], repo);
  const guidelines = await readGuidelines(guidelinesSha, repo);

  // Paths handed to the judge (cwd, skill, settings) are canonical so the
  // CLI's own realpath comparisons match them.
  const rootDir = await realpath(
    await mkdtemp(join(tmpdir(), "pr-risk-evidence-")),
  );
  try {
    const evidenceDir = join(rootDir, "evidence");
    const headTreeDir = join(evidenceDir, "head");
    const diffPath = join(evidenceDir, "pr.diff");
    const inventoryPath = join(evidenceDir, "changed-files.json");
    await mkdir(evidenceDir, { recursive: true });
    await git(
      [
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        `--output=${diffPath}`,
        mergeBase,
        headSha,
      ],
      repo,
    );
    await writeFile(
      inventoryPath,
      `${JSON.stringify(
        {
          totals: {
            files: snapshot.pullRequest.changedFiles,
            additions: snapshot.pullRequest.additions,
            deletions: snapshot.pullRequest.deletions,
          },
          files: snapshot.files,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    let guidelinesPath: string | null = null;
    if (guidelines !== null) {
      guidelinesPath = join(evidenceDir, "pr-risk-guidelines.md");
      await writeFile(guidelinesPath, `${guidelines}\n`, "utf8");
    }
    await git(["worktree", "add", "--detach", headTreeDir, headSha], repo);
    const hash = createHash("sha256")
      .update(headSha)
      .update("\0")
      .update(JSON.stringify(snapshot))
      .update("\0");
    for await (const chunk of createReadStream(diffPath)) hash.update(chunk);
    // Appended only when present, so hashes of repositories without
    // guidelines are unchanged.
    if (guidelines !== null) hash.update("\0").update(guidelines);
    return {
      rootDir,
      headTreeDir,
      diffPath,
      inventoryPath,
      guidelinesPath,
      snapshotHash: hash.digest("hex"),
    };
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Unregisters the head worktree from its repository, then removes the
 * workspace. The worktree is found through its own pointer file, so the
 * caller need not know which repository produced the evidence.
 *
 * When git refuses to remove the worktree (a lock, or a judge subprocess that
 * outlived its session still writing into it), the refusal propagates and
 * nothing else is deleted: git's refusal is the safeguard, and the directory
 * stays for whoever owns the checkout to inspect. In particular no path read
 * from the worktree's `.git` pointer is ever deleted, because head code the
 * judge ran can rewrite that file.
 */
export async function removePrRiskEvidenceWorkspace(
  evidence: PrRiskEvidenceWorkspace,
): Promise<void> {
  await git(["worktree", "remove", "--force", evidence.headTreeDir], {
    cwd: evidence.headTreeDir,
  });
  await rm(evidence.rootDir, REMOVE_WORKSPACE_OPTIONS);
}

/**
 * Installs the rendered skill as the workspace's one project skill, where
 * `droid exec` discovers it for the `/pr-risk-judge` prompt.
 */
export async function writePrRiskSkill(
  evidence: PrRiskEvidenceWorkspace,
  skill: string,
): Promise<string> {
  const skillDir = join(
    evidence.rootDir,
    ".factory",
    "skills",
    RISK_JUDGE_SKILL_NAME,
  );
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(skillPath, skill, "utf8");
  return skillPath;
}

/** Writes the judge session's settings file exactly as Factory served it. */
export async function writePrRiskSettings(
  evidence: PrRiskEvidenceWorkspace,
  settings: Record<string, unknown>,
): Promise<string> {
  const settingsPath = join(evidence.rootDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify(settings), "utf8");
  return settingsPath;
}
