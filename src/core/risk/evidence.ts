import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { GITHUB_SERVER_URL } from "../../github/api/config";
import { escapeRegExp } from "../../github/validation/trigger";
import {
  MAX_INCREMENTAL_PATHS,
  buildFocus,
  changedOwnPaths,
  importStem,
  importsModule,
  isTestPath,
  parseDiffFootprints,
  scanInterdiff,
} from "./incremental";
import { buildPrRiskSnapshot } from "./snapshot";
import {
  RISK_JUDGE_SKILL_NAME,
  RiskError,
  failureReason,
  type PrRiskEvidenceWorkspace,
  type PrRiskIncrementalEvidence,
  type RiskIncremental,
  type PullRequestRiskFile,
  type PullRequestRiskFileStatus,
  type PullRequestRiskSnapshot,
  type PullRequestRiskTarget,
  type RiskPriorDecline,
} from "./types";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const GUIDELINES_REPO_PATH = ".factory/pr-risk/guidelines.md";
/** Where a judge saves a script it wrote for a check, under the workspace root. */
const CHECKS_DIR = join("evidence", "checks");
// The diff and the changed-file list are both taken with these, so the two
// describe one comparison.
const DIFF_OPTIONS = ["--no-ext-diff", "--no-textconv", "--find-renames"];
// The judge is shown this many changed files by name, which is as many as
// GitHub lists for a pull request; the rest are only counted.
const MAX_LISTED_FILES = 3000;
// What `git diff --name-status` calls each change. Anything else, such as a
// file that became a symlink, is reported as changed.
const FILE_STATUSES: Record<string, PullRequestRiskFileStatus> = {
  A: "added",
  D: "removed",
  M: "modified",
  R: "renamed",
  C: "copied",
};
// How actions/checkout keeps a credential in a clone's configuration: its
// token as a request header, and an SSH key as the command naming the key's
// file.
const TOKEN_HEADER_KEY = /^http\.(.*\.)?extraheader$/;
const SSH_COMMAND_KEY = "core.sshcommand";
// Retries cover files that appear while a directory is being emptied.
// Importers are searched for this many changed source files at most, in one
// `git grep`; the rest are listed without importers.
const MAX_IMPORTER_SEARCHES = 200;
const SOURCE_PATHSPECS = [
  "*.ts",
  "*.tsx",
  "*.js",
  "*.jsx",
  "*.mjs",
  "*.cjs",
  "*.mts",
  "*.cts",
];
export const REMOVE_WORKSPACE_OPTIONS = {
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
 * Runs one git command against the repository and returns its trimmed stdout,
 * or all of it with `raw`: a NUL-delimited listing must keep a space that
 * begins or ends its first or last path. Only the repository's own
 * configuration applies: host-level config, attributes, and hooks cannot
 * change what a head checks out as, so the same commit yields the same
 * evidence on every machine.
 */
export async function git(
  args: readonly string[],
  repo: GitRepo,
  options: { raw?: boolean } = {},
): Promise<string> {
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
    return options.raw ? stdout : stdout.trim();
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
 * request cannot rewrite the policy it is judged against. `text` is null
 * when that commit has no such file or it is empty; `blobSha` is null only
 * when there is no file, since Factory compares it with the blob it reads
 * from GitHub.
 */
async function readGuidelines(
  commit: string,
  repo: GitRepo,
): Promise<{ text: string | null; blobSha: string | null }> {
  const entry = await git(
    ["ls-tree", commit, "--", GUIDELINES_REPO_PATH],
    repo,
  );
  if (!entry) return { text: null, blobSha: null };
  const [mode, type, blobSha = ""] = entry.split(/\s/);
  if (
    type !== "blob" ||
    (mode !== "100644" && mode !== "100755") ||
    !/^[0-9a-f]{40}$/.test(blobSha)
  ) {
    throw new RiskError(
      "pr_risk_guidelines_invalid",
      "PR risk guidelines are not a regular file",
    );
  }
  const guidelines = await git(
    ["cat-file", "blob", `${commit}:${GUIDELINES_REPO_PATH}`],
    repo,
  );
  return { text: guidelines || null, blobSha };
}

/**
 * Lists every file that differs between two commits, with its line counts.
 * A binary file counts no lines.
 */
async function listChangedFiles(
  from: string,
  to: string,
  repo: GitRepo,
): Promise<PullRequestRiskFile[]> {
  const records = async (format: string) =>
    (
      await git(
        ["--no-pager", "diff", ...DIFF_OPTIONS, format, "-z", from, to],
        repo,
        { raw: true },
      )
    ).split("\0");

  // One record per file, `<added>\t<deleted>\t<path>`. A rename leaves the
  // path empty and gives the old and the new one as the next two records.
  const lines = new Map<string, { additions: number; deletions: number }>();
  const counts = await records("--numstat");
  for (let index = 0; index < counts.length; index++) {
    const count = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(counts[index] ?? "");
    if (!count) continue;
    let path = count[3];
    if (!path) {
      index += 2;
      path = counts[index];
    }
    if (path === undefined) continue;
    lines.set(path, {
      additions: Number(count[1]) || 0,
      deletions: Number(count[2]) || 0,
    });
  }

  // A status, then its path; a rename or a copy has the old path first.
  const files: PullRequestRiskFile[] = [];
  const statuses = await records("--name-status");
  for (let index = 0; index < statuses.length; index++) {
    const letter = statuses[index]?.[0];
    if (!letter) continue;
    const previousFilename =
      letter === "R" || letter === "C" ? statuses[++index] : undefined;
    const filename = statuses[++index];
    const counted = filename === undefined ? undefined : lines.get(filename);
    if (filename === undefined || !counted) {
      throw new RiskError(
        "pr_risk_inventory_unreadable",
        "PR risk could not list the changed files",
      );
    }
    files.push({
      filename,
      ...(previousFilename ? { previousFilename } : {}),
      status: FILE_STATUSES[letter] ?? "changed",
      ...counted,
    });
  }
  return files;
}

/**
 * Creates the evidence workspace a judge reads: the merge-base diff written
 * straight to disk, the changed-file inventory, the default branch's PR risk
 * guidelines when it has them, and the exact head checked out as a detached
 * worktree. The inventory and the snapshot's counts are read from the same
 * two commits as the diff, so nothing GitHub says about the pull request
 * while the run is under way can make them describe another comparison. The
 * worktree's `.git` is a pointer file into the repository, so git commands
 * run inside it (history, blame) resolve against the caller's checkout. The
 * base revision is used only to compute the diff and is not named to the
 * model.
 */
export async function createPrRiskEvidenceWorkspace(
  pullRequest: PullRequestRiskTarget,
  options: {
    repoDir: string;
    githubToken: string;
    priorDeclines?: readonly RiskPriorDecline[];
    incremental?: RiskIncremental;
  },
): Promise<{
  snapshot: PullRequestRiskSnapshot;
  evidence: PrRiskEvidenceWorkspace;
  /** Why the incremental evidence asked for could not be built. */
  incrementalFallback?: string;
}> {
  const { baseSha, headSha, prNumber } = pullRequest;
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
  const { text: guidelines, blobSha: guidelinesBlobSha } = await readGuidelines(
    guidelinesSha,
    repo,
  );
  const changed = await listChangedFiles(mergeBase, headSha, repo);
  const linesChanged = (kind: "additions" | "deletions") =>
    changed.reduce((total, file) => total + file[kind], 0);
  const snapshot = buildPrRiskSnapshot(
    {
      ...pullRequest,
      additions: linesChanged("additions"),
      deletions: linesChanged("deletions"),
      changedFiles: changed.length,
    },
    changed.slice(0, MAX_LISTED_FILES),
    options.priorDeclines,
  );

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
        ...DIFF_OPTIONS,
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
    let incremental: PrRiskIncrementalEvidence | undefined;
    let incrementalFallback: string | undefined;
    if (options.incremental) {
      try {
        const written = await writeIncrementalEvidence({
          repo,
          evidenceDir,
          diffPath,
          mergeBase,
          headSha,
          incremental: options.incremental,
        });
        // Where the judge saves a script it writes for a check, so the
        // runner can run that check again.
        await mkdir(join(rootDir, CHECKS_DIR));
        incremental = written;
      } catch (error) {
        // The full evidence is already on disk, so the head is judged
        // afresh rather than not at all.
        incrementalFallback = failureReason(error);
        console.warn(
          `PR risk incremental evidence unavailable (${incrementalFallback}); judging the full change`,
        );
      }
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
    if (incremental && options.incremental) {
      hash
        .update("\0incremental\0")
        .update(JSON.stringify(options.incremental))
        .update("\0");
      for await (const chunk of createReadStream(incremental.interdiffPath)) {
        hash.update(chunk);
      }
    }
    return {
      snapshot,
      evidence: {
        rootDir,
        headTreeDir,
        diffPath,
        inventoryPath,
        guidelinesPath,
        guidelinesBlobSha,
        snapshotHash: hash.digest("hex"),
        ...(incremental ? { incremental } : {}),
      },
      ...(incrementalFallback ? { incrementalFallback } : {}),
    };
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Writes what an incremental judgment reads next to the full evidence: the
 * pull request's own diff at the prior head, the head-tree changes since the
 * prior head on every path whose own change moved, and a focus list naming
 * the changed symbols, their importers, the tests that exercise them, and
 * the paths the prior verdict discussed. Paths the base alone changed are
 * left out, so a merge of the base into the branch is not mistaken for the
 * author's work.
 */
async function writeIncrementalEvidence(input: {
  repo: GitRepo;
  evidenceDir: string;
  diffPath: string;
  mergeBase: string;
  headSha: string;
  incremental: RiskIncremental;
}): Promise<PrRiskIncrementalEvidence> {
  const { repo, incremental, headSha } = input;
  const { priorHeadSha, priorBaseSha } = incremental;
  try {
    await git(
      ["fetch", "--no-tags", "origin", priorBaseSha, priorHeadSha],
      repo,
    );
  } catch {
    // Both may already be here; they are verified below either way.
  }
  for (const sha of [priorBaseSha, priorHeadSha]) {
    const resolved = await git(
      ["rev-parse", "--verify", `${sha}^{commit}`],
      repo,
    );
    if (resolved !== sha) {
      throw new RiskError(
        "pr_risk_prior_unresolved",
        "PR risk could not resolve the prior revisions",
      );
    }
  }
  const priorMergeBase = await git(
    ["merge-base", priorBaseSha, priorHeadSha],
    repo,
  );
  const priorDiffPath = join(input.evidenceDir, "own-diff-at-prior.patch");
  const interdiffPath = join(input.evidenceDir, "interdiff.patch");
  const focusPath = join(input.evidenceDir, "focus.json");
  await git(
    [
      "--no-pager",
      "diff",
      ...DIFF_OPTIONS,
      `--output=${priorDiffPath}`,
      priorMergeBase,
      priorHeadSha,
    ],
    repo,
  );
  const baseMoved = priorMergeBase !== input.mergeBase;
  const upstreamPaths = new Set(
    baseMoved
      ? (
          await git(
            [
              "--no-pager",
              "diff",
              "--name-only",
              "-z",
              priorMergeBase,
              input.mergeBase,
            ],
            repo,
            { raw: true },
          )
        )
          .split("\0")
          .filter(Boolean)
      : [],
  );
  const changed = changedOwnPaths(
    parseDiffFootprints(await readFile(priorDiffPath, "utf8")),
    parseDiffFootprints(await readFile(input.diffPath, "utf8")),
    upstreamPaths,
  );
  if (changed.length > MAX_INCREMENTAL_PATHS) {
    throw new RiskError(
      "pr_risk_incremental_too_wide",
      "Too many paths changed since the prior verdict",
    );
  }
  const pathspecs = [
    ...new Set(
      changed.flatMap((entry) =>
        entry.previousPath ? [entry.path, entry.previousPath] : [entry.path],
      ),
    ),
  ].map((path) => `:(literal)${path}`);
  if (pathspecs.length === 0) {
    await writeFile(interdiffPath, "", "utf8");
  } else {
    await git(
      [
        "--no-pager",
        "diff",
        ...DIFF_OPTIONS,
        `--output=${interdiffPath}`,
        priorHeadSha,
        headSha,
        "--",
        ...pathspecs,
      ],
      repo,
    );
  }
  const importers = new Map<string, string[]>();
  const sources = changed.filter(
    (entry) =>
      entry.change !== "removed_from_pr" &&
      !isTestPath(entry.path) &&
      importStem(entry.path) !== null,
  );
  const searched = sources.slice(0, MAX_IMPORTER_SEARCHES).flatMap((entry) => {
    const stem = importStem(entry.path);
    return stem ? [{ path: entry.path, stem }] : [];
  });
  if (searched.length > 0) {
    const names = [
      ...new Set(searched.map(({ stem }) => stem.split("/").at(-1) ?? stem)),
    ];
    const pattern = `['"][^'"]*\\b(${names
      .map(escapeRegExp)
      .join("|")})(/index)?(\\.[cm]?[jt]sx?)?['"]`;
    let output = "";
    try {
      // One search for every stem: each match is printed as
      // `<rev>:<path>\0<matched specifier>`, so it can be attributed.
      output = await git(
        [
          "grep",
          "-o",
          "-z",
          "-E",
          "-e",
          pattern,
          headSha,
          "--",
          ...SOURCE_PATHSPECS,
        ],
        repo,
        { raw: true },
      );
    } catch (error) {
      // `git grep` exits 1 when nothing matches; anything else leaves the
      // focus list without importers, which the log should say.
      const cause = error instanceof Error ? error.cause : undefined;
      if (!(cause instanceof Error && "code" in cause && cause.code === 1)) {
        console.warn(
          `PR risk importer search failed: ${error instanceof Error ? error.message : "git grep failed"}`,
        );
      }
    }
    for (const line of output.split("\n")) {
      const separator = line.indexOf("\0");
      if (separator === -1) continue;
      const importer = line.slice(headSha.length + 1, separator);
      const specifier = line.slice(separator + 1).slice(1, -1);
      for (const { path, stem } of searched) {
        if (importer === path) continue;
        if (!importsModule(importer, specifier, stem)) continue;
        const list = importers.get(path) ?? [];
        if (!list.includes(importer)) list.push(importer);
        importers.set(path, list);
      }
    }
    for (const list of importers.values()) list.sort();
  }
  const dirs = [
    ...new Set(
      sources
        .map((entry) => entry.path.slice(0, entry.path.lastIndexOf("/") + 1))
        // A test beside a root-level file is not looked for.
        .filter(Boolean),
    ),
  ];
  const stems = new Set(
    sources.map((entry) =>
      (entry.path.split("/").at(-1) ?? "").replace(/\.[^.]+$/, ""),
    ),
  );
  const siblingTests =
    dirs.length === 0
      ? []
      : (
          await git(
            [
              "ls-tree",
              "-r",
              "--name-only",
              "-z",
              headSha,
              "--",
              ...dirs.map((dir) => `:(literal)${dir}`),
            ],
            repo,
            { raw: true },
          )
        )
          .split("\0")
          .filter((path) => {
            const name = path.split("/").at(-1) ?? "";
            const stem = name.replace(/\.(?:spec|test)\.[^.]+$/i, "");
            return isTestPath(path) && stem !== name && stems.has(stem);
          });
  const focus = buildFocus({
    priorHeadSha,
    baseMoved,
    changed,
    upstreamPaths,
    scanned: scanInterdiff(await readFile(interdiffPath, "utf8")),
    importers,
    siblingTests,
    prior: incremental.prior,
  });
  await writeFile(focusPath, `${JSON.stringify(focus, null, 2)}\n`, "utf8");
  return { interdiffPath, priorDiffPath, focusPath, focus };
}

/** One configuration git can list: what it reads from `cwd`, or one file. */
type GitConfig = { cwd: string; file?: string };

/**
 * Finds the credentials in one configuration, each as its key and the file
 * that sets it. Only names are read, never values.
 */
async function persistedCredentials(
  config: GitConfig,
): Promise<Array<{ file: string; key: string }>> {
  const fields = (
    await git(
      [
        "config",
        ...(config.file ? ["--file", config.file, "--includes"] : []),
        "--list",
        "--show-origin",
        "--name-only",
        "-z",
      ],
      { cwd: config.cwd },
      { raw: true },
    )
  ).split("\0");
  const found: Array<{ file: string; key: string }> = [];
  // The file a key comes from, then the key.
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const key = fields[index + 1] ?? "";
    if (!TOKEN_HEADER_KEY.test(key) && key !== SSH_COMMAND_KEY) continue;
    // A file inside the repository is named relative to `cwd`.
    const origin = (fields[index] ?? "").replace(/^file:/, "");
    found.push({ file: resolve(config.cwd, origin), key });
  }
  return found;
}

/**
 * The config file of every submodule whose git directory is kept under
 * `modulesDir`. A submodule named `a/b` keeps its git directory at `a/b`,
 * and those of its own submodules under `a/b/modules`.
 */
async function submoduleConfigFiles(modulesDir: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(modulesDir, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(modulesDir, entry.name);
    const config = join(dir, "config");
    const isGitDir = await stat(config).then(
      (info) => info.isFile(),
      () => false,
    );
    if (isGitDir) found.push(config);
    found.push(
      ...(await submoduleConfigFiles(isGitDir ? join(dir, "modules") : dir)),
    );
  }
  return found;
}

/**
 * Takes the credentials a checkout persisted out of the judge's reach.
 * `actions/checkout` leaves its token in the clone's git configuration
 * unless told `persist-credentials: false`, and the head worktree reads that
 * same configuration, so a command the judge runs from the pull request
 * could use a token that writes. The token is removed from every file that
 * sets it: the checkout's config, the files it includes, and each
 * submodule's config. An SSH key cannot be taken away like that, because its
 * file stays on disk, so a checkout that configures one is refused. Throws
 * rather than let a judge start while either can still be read.
 */
export async function removeCheckoutCredentials(
  repoDir: string,
  headTreeDir: string,
): Promise<void> {
  const commonDir = resolve(
    repoDir,
    await git(["rev-parse", "--git-common-dir"], { cwd: repoDir }),
  );
  // A submodule's config is read as a file, because git refuses to run in a
  // submodule's git directory once the submodule's files are gone, which is
  // how a workspace reused between runs can leave it.
  const configs: GitConfig[] = [
    { cwd: repoDir },
    { cwd: headTreeDir },
    ...(await submoduleConfigFiles(join(commonDir, "modules"))).map((file) => ({
      cwd: repoDir,
      file,
    })),
  ];
  for (const config of configs) {
    // Listed again after each removal, so a file two of these both read is
    // only ever asked to drop a key it still has.
    for (;;) {
      const token = (await persistedCredentials(config)).find(({ key }) =>
        TOKEN_HEADER_KEY.test(key),
      );
      if (!token) break;
      await git(["config", "--file", token.file, "--unset-all", token.key], {
        cwd: config.cwd,
      });
    }
  }
  for (const config of configs) {
    if ((await persistedCredentials(config)).length > 0) {
      throw new RiskError(
        "checkout_credentials_persisted",
        "The checkout keeps a git credential the judge could read, such as an SSH key; check out over HTTPS with persist-credentials: false",
      );
    }
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

/**
 * A digest of everything under the workspace's `evidence/`: every path, its
 * kind, and each file's bytes or each link's target. The runner reads the
 * files itself, with no git, so code a session ran cannot vouch for them.
 */
export async function fingerprintPrRiskEvidence(
  evidence: PrRiskEvidenceWorkspace,
): Promise<string> {
  const digest = createHash("sha256");
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) {
        digest.update(`link\0${name}\0${await readlink(path)}\0`);
      } else if (entry.isDirectory()) {
        digest.update(`dir\0${name}\0`);
        await walk(path, `${name}/`);
      } else if (entry.isFile()) {
        // Each file's own digest, so no file's bytes can pose as the
        // entries after it.
        const file = createHash("sha256");
        for await (const chunk of createReadStream(path)) file.update(chunk);
        digest.update(`file\0${name}\0${file.digest("hex")}\0`);
      } else {
        digest.update(`other\0${name}\0`);
      }
    }
  };
  await walk(join(evidence.rootDir, "evidence"), "");
  return digest.digest("hex");
}
