import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { FetchLike } from "./api";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
// Fetching a head the job's checkout does not hold can move a lot of history.
const GIT_FETCH_TIMEOUT_MS = 600_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const GUIDELINES_REPO_PATH = ".factory/pr-risk/guidelines.md";
const PAGE_SIZE = 100;

export const RISK_JUDGE_SKILL_NAME = "pr-risk-judge";
const SNAPSHOT_PLACEHOLDER = "{{PR_SNAPSHOT_JSON}}";

const fileStatuses = [
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
] as const;
type RiskFileKind = "runtime" | "test" | "docs" | "generated_or_lock";

export type RiskFile = {
  filename: string;
  previousFilename?: string;
  status: (typeof fileStatuses)[number];
  additions: number;
  deletions: number;
};

export type RiskPullRequest = {
  repo: string;
  prNumber: number;
  title: string;
  baseSha: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
};

export type RiskPriorDecline = { headSha: string; concerns: string };

/** The compact exact-head inventory the judge is shown. */
export type RiskSnapshot = {
  pullRequest: RiskPullRequest;
  priorDeclines: readonly RiskPriorDecline[];
  summary: {
    runtimeFiles: number;
    testFiles: number;
    docsFiles: number;
    generatedOrLockFiles: number;
    runtimeLinesChanged: number;
    testLinesChanged: number;
    unlistedFiles: number;
    workspaces: readonly string[];
  };
  files: readonly (RiskFile & { kind: RiskFileKind })[];
};

/** On-disk evidence and the private directories of one judge run. */
export type RiskEvidenceWorkspace = {
  /** Removed whole when the run ends. */
  workDir: string;
  /** The judge's working directory: its skill, settings and `evidence/`. */
  rootDir: string;
  homeDir: string;
  tmpDir: string;
  headTreeDir: string;
  diffPath: string;
  inventoryPath: string;
  guidelinesPath: string | null;
  snapshotHash: string;
};

const pullRequestSchema = z.object({
  title: z.string(),
  head: z.object({ sha: z.string() }),
  additions: z.number().int(),
  deletions: z.number().int(),
  changed_files: z.number().int(),
});
const fileListSchema = z.array(
  z.object({
    filename: z.string(),
    previous_filename: z.string().optional(),
    status: z.enum(fileStatuses),
    additions: z.number().int(),
    deletions: z.number().int(),
  }),
);

/**
 * Reads the live pull request and its changed-file inventory with the
 * judge's read-only token. GitHub lists at most 3,000 files; the snapshot
 * counts the rest as unlisted.
 */
export async function fetchRiskPullRequest(options: {
  repo: string;
  pr: number;
  token: string;
  apiUrl: string;
  fetchImpl?: FetchLike;
}): Promise<{
  title: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: RiskFile[];
}> {
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((url, init) => fetch(url, init));
  const read = async (path: string): Promise<unknown> => {
    const response = await fetchImpl(`${options.apiUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`GitHub answered ${response.status} for ${path}`);
    return response.json();
  };
  const base = `/repos/${options.repo}/pulls/${options.pr}`;
  const pullRequest = pullRequestSchema.parse(await read(base));
  const files: RiskFile[] = [];
  for (let page = 1; ; page++) {
    const rows = fileListSchema.parse(
      await read(`${base}/files?per_page=${PAGE_SIZE}&page=${page}`),
    );
    for (const row of rows)
      files.push({
        filename: row.filename,
        ...(row.previous_filename
          ? { previousFilename: row.previous_filename }
          : {}),
        status: row.status,
        additions: row.additions,
        deletions: row.deletions,
      });
    if (rows.length < PAGE_SIZE) break;
  }
  return {
    title: pullRequest.title,
    headSha: pullRequest.head.sha,
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    changedFiles: pullRequest.changed_files,
    files,
  };
}

const TEST_PATH =
  /(?:^|\/)(?:__tests__|e2e|test|tests)(?:\/|$)|\.(?:spec|test)\.[^.]+$/i;
const DOCS_PATH = /(?:^|\/)(?:docs?|examples?)(?:\/|$)|\.(?:md|mdx|rst|txt)$/i;
const EXECUTABLE_MARKDOWN_PATH =
  /(?:^|\/)(?:prompts?|skills?|\.factory)(?:\/|$)|(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$/i;
const GENERATED_OR_LOCK_PATH =
  /(?:^|\/)(?:__snapshots__|fixtures?|generated|dist|coverage)(?:\/|$)|(?:^|\/)(?:package-lock\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml|dependency-graph\.json)$/i;
const WORKSPACE_PATH = /^(apps|packages|internal|infra|evals)\/([^/]+)\//;

function classifyFile(filename: string): RiskFileKind {
  if (GENERATED_OR_LOCK_PATH.test(filename)) return "generated_or_lock";
  if (TEST_PATH.test(filename)) return "test";
  // Prompts, skills and agent instructions run, whatever their extension.
  if (EXECUTABLE_MARKDOWN_PATH.test(filename)) return "runtime";
  if (DOCS_PATH.test(filename)) return "docs";
  return "runtime";
}

/**
 * Builds the inventory presented to the judge. Patch bodies live in the
 * on-disk diff and never enter the snapshot. Key order is part of the
 * snapshot hash and matches the runner this client replaces.
 */
export function buildRiskSnapshot(
  pullRequest: RiskPullRequest,
  files: readonly RiskFile[],
  priorDeclines: readonly RiskPriorDecline[],
): RiskSnapshot {
  const categorized = files
    .map((file) => ({ ...file, kind: classifyFile(file.filename) }))
    .sort((left, right) => left.filename.localeCompare(right.filename));
  const ofKind = (kind: RiskFileKind) =>
    categorized.filter((file) => file.kind === kind);
  const linesChanged = (rows: readonly RiskFile[]) =>
    rows.reduce((total, file) => total + file.additions + file.deletions, 0);
  const runtimeFiles = ofKind("runtime");
  const testFiles = ofKind("test");
  const workspaces = new Set<string>();
  for (const file of [...runtimeFiles, ...testFiles]) {
    const match = WORKSPACE_PATH.exec(file.filename);
    workspaces.add(match ? `${match[1]}/${match[2]}` : "root");
  }
  return {
    pullRequest,
    priorDeclines,
    summary: {
      runtimeFiles: runtimeFiles.length,
      testFiles: testFiles.length,
      docsFiles: ofKind("docs").length,
      generatedOrLockFiles: ofKind("generated_or_lock").length,
      runtimeLinesChanged: linesChanged(runtimeFiles),
      testLinesChanged: linesChanged(testFiles),
      unlistedFiles: Math.max(0, pullRequest.changedFiles - files.length),
      workspaces: [...workspaces].sort(),
    },
    files: categorized,
  };
}

/**
 * Renders the judge's skill for one pull request: the snapshot replaces the
 * placeholder in the skill body, or is appended when the skill carries
 * none. The base revision is used only to compute the diff and is not named
 * to the model.
 */
export function renderRiskSkill(
  skill: string,
  snapshot: RiskSnapshot,
  evidence: RiskEvidenceWorkspace,
): string {
  const { baseSha: _baseSha, ...pullRequest } = snapshot.pullRequest;
  const snapshotJson = JSON.stringify(
    {
      pullRequest,
      summary: snapshot.summary,
      changedFiles: snapshot.files,
      priorDeclines: snapshot.priorDeclines,
      evidence: {
        diffPath: evidence.diffPath,
        headTreePath: evidence.headTreeDir,
        inventoryPath: evidence.inventoryPath,
        guidelinesPath: evidence.guidelinesPath,
      },
    },
    null,
    2,
  );
  if (skill.includes(SNAPSHOT_PLACEHOLDER))
    return skill.replaceAll(SNAPSHOT_PLACEHOLDER, () => snapshotJson);
  return `${skill.trimEnd()}\n\n## PR snapshot\n\n\`\`\`json\n${snapshotJson}\n\`\`\`\n`;
}

type GitContext = {
  cwd: string;
  homeDir: string;
  /** Sent only to `serverUrl`, and only by this process's own git calls. */
  auth?: { token: string; serverUrl: string };
  safeDirectory?: string;
};

function resolveGit(): string {
  // An absolute path, so a PATH entry written during the review phase
  // cannot stand in for git.
  return (
    ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"].find((candidate) =>
      existsSync(candidate),
    ) ?? "git"
  );
}

/**
 * Runs one git command and returns its trimmed stdout. No system or user
 * configuration, hooks, attributes or replace refs apply, so the same
 * commit yields the same evidence whatever ran earlier in the job.
 */
async function git(
  args: readonly string[],
  context: GitContext,
  timeout = GIT_TIMEOUT_MS,
): Promise<string> {
  const config: [string, string][] = [];
  if (context.auth)
    config.push([
      `http.${context.auth.serverUrl}/.extraheader`,
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${context.auth.token}`).toString("base64")}`,
    ]);
  if (context.safeDirectory)
    config.push(["safe.directory", context.safeDirectory]);
  const { stdout } = await execFileAsync(
    resolveGit(),
    ["-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd: context.cwd,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: context.homeDir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: String(config.length),
        ...Object.fromEntries(
          config.flatMap(([key, value], index) => [
            [`GIT_CONFIG_KEY_${index}`, key],
            [`GIT_CONFIG_VALUE_${index}`, value],
          ]),
        ),
      },
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout,
    },
  );
  return stdout.trim();
}

/**
 * Reads the repository's risk guidelines from one verified commit on the
 * default branch. The pull request's own commits are never read, so a pull
 * request cannot rewrite the policy it is judged against.
 */
async function readGuidelines(
  commit: string,
  context: GitContext,
): Promise<string | null> {
  const entry = await git(
    ["ls-tree", commit, "--", GUIDELINES_REPO_PATH],
    context,
  );
  if (!entry) return null;
  const [mode, type] = entry.split(/\s/u);
  if (type !== "blob" || (mode !== "100644" && mode !== "100755"))
    throw new Error("Risk guidelines are not a regular file");
  const guidelines = await git(
    ["cat-file", "blob", `${commit}:${GUIDELINES_REPO_PATH}`],
    context,
  );
  return guidelines || null;
}

/**
 * Builds the evidence one judge reads, in a repository of its own under
 * `parentDir`: the merge-base diff, the changed-file inventory, the default
 * branch's guidelines when it has them, and the exact head checked out as a
 * detached worktree.
 *
 * The repository borrows the job checkout's objects when there is one
 * (`--shared`), so nothing already fetched is fetched again, but it takes
 * no configuration, hooks or refs-in-use from it. Revisions come from the
 * plan and are fetched from the remote and verified by commit id.
 */
export async function createRiskEvidenceWorkspace(
  snapshot: RiskSnapshot,
  options: {
    parentDir: string;
    remoteUrl: string;
    sourceRepoDir?: string;
    auth?: { token: string; serverUrl: string };
  },
): Promise<RiskEvidenceWorkspace> {
  const { baseSha, headSha, prNumber } = snapshot.pullRequest;
  // Paths handed to the judge are canonical so the CLI's own realpath
  // comparisons match them.
  const workDir = await realpath(
    await mkdtemp(join(options.parentDir, "droid-risk-evidence-")),
  );
  try {
    const repoDir = join(workDir, "repo.git");
    const rootDir = join(workDir, "judge");
    const homeDir = join(workDir, "home");
    const tmpDir = join(workDir, "tmp");
    const evidenceDir = join(rootDir, "evidence");
    for (const directory of [homeDir, tmpDir, evidenceDir])
      await mkdir(directory, { recursive: true, mode: 0o700 });

    const outside: GitContext = { cwd: workDir, homeDir };
    let borrowed = false;
    if (options.sourceRepoDir) {
      try {
        await git(
          [
            "clone",
            "--quiet",
            "--bare",
            "--shared",
            options.sourceRepoDir,
            repoDir,
          ],
          { ...outside, safeDirectory: options.sourceRepoDir },
        );
        borrowed = true;
      } catch {
        await rm(repoDir, { recursive: true, force: true });
        console.log(
          "The job checkout could not be borrowed from; fetching all evidence",
        );
      }
    }
    if (!borrowed) await git(["init", "--quiet", "--bare", repoDir], outside);
    const repo: GitContext = {
      cwd: repoDir,
      homeDir,
      auth: options.auth,
      safeDirectory: options.sourceRepoDir,
    };

    // Guidelines come from the default branch tip, not the pull request's
    // base: a base can be a branch the author controls.
    const remoteHead = await git(
      ["ls-remote", "--symref", options.remoteUrl, "HEAD"],
      repo,
    );
    const guidelinesSha = /^([0-9a-f]{40})\tHEAD$/mu.exec(remoteHead)?.[1];
    if (!/^ref: refs\/heads\/\S+\tHEAD$/mu.test(remoteHead) || !guidelinesSha)
      throw new Error("Could not resolve the default branch");
    await git(
      [
        "fetch",
        "--quiet",
        "--no-tags",
        options.remoteUrl,
        baseSha,
        `refs/pull/${prNumber}/head`,
        guidelinesSha,
      ],
      repo,
      GIT_FETCH_TIMEOUT_MS,
    );
    for (const sha of [baseSha, headSha, guidelinesSha]) {
      const resolved = await git(
        ["rev-parse", "--verify", `${sha}^{commit}`],
        repo,
      );
      if (resolved !== sha)
        throw new Error("Risk evidence revisions did not resolve exactly");
    }
    const mergeBase = await git(["merge-base", baseSha, headSha], repo);
    const guidelines = await readGuidelines(guidelinesSha, repo);

    const headTreeDir = join(evidenceDir, "head");
    const diffPath = join(evidenceDir, "pr.diff");
    const inventoryPath = join(evidenceDir, "changed-files.json");
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
    );
    let guidelinesPath: string | null = null;
    if (guidelines !== null) {
      guidelinesPath = join(evidenceDir, "pr-risk-guidelines.md");
      await writeFile(guidelinesPath, `${guidelines}\n`);
    }
    await git(
      ["worktree", "add", "--quiet", "--detach", headTreeDir, headSha],
      repo,
      GIT_FETCH_TIMEOUT_MS,
    );
    const hash = createHash("sha256")
      .update(headSha)
      .update("\0")
      .update(JSON.stringify(snapshot))
      .update("\0");
    for await (const chunk of createReadStream(diffPath)) hash.update(chunk);
    // Appended only when present, so repositories without guidelines hash
    // as they always did.
    if (guidelines !== null) hash.update("\0").update(guidelines);
    return {
      workDir,
      rootDir,
      homeDir,
      tmpDir,
      headTreeDir,
      diffPath,
      inventoryPath,
      guidelinesPath,
      snapshotHash: hash.digest("hex"),
    };
  } catch (error) {
    await removeRiskEvidenceWorkspace(workDir);
    throw error;
  }
}

/**
 * Removes one run's evidence, repository and private home. Never throws: by
 * now the judge has answered or failed on its own, and a directory that
 * cannot be deleted must not change that.
 */
export async function removeRiskEvidenceWorkspace(
  workDir: string,
): Promise<void> {
  try {
    await rm(workDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    });
  } catch {
    console.log("The risk evidence workspace could not be removed");
  }
}
