import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { GITHUB_SERVER_URL } from "../../github/api/config";
import { StepError } from "./step";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
// How actions/checkout keeps a credential in a clone's configuration: its
// token as a request header, and an SSH key as the command naming the key's
// file.
const TOKEN_HEADER_KEY = /^http\.(.*\.)?extraheader$/;
const SSH_COMMAND_KEY = "core.sshcommand";

/** A checkout, and the token its remote is read with when a command needs one. */
export type GitRepo = { cwd: string; githubToken?: string };

/**
 * The environment every git command of a worker step runs in: an allow-list,
 * so no credential of the job reaches git, plus the token as a request header
 * for this one command.
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
 * begins or ends its first or last field. Only the repository's own
 * configuration applies: host-level config and hooks stay out of it.
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
    throw new StepError(
      "evidence_git_failed",
      error instanceof Error ? error.message : "git failed",
      { cause: error },
    );
  }
}

/**
 * Fetches into the checkout what a worker reads of a pull request and never
 * fetches itself: the pull request's head and `commits`, with the history
 * behind them.
 */
export async function fetchPullRequest(
  repo: GitRepo,
  pr: number,
  commits: readonly string[],
): Promise<void> {
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
      ...commits,
      `refs/pull/${pr}/head`,
    ],
    repo,
  );
}

/** Fetches commits by ID, which fails when the remote no longer has one. */
export async function fetchCommits(
  repo: GitRepo,
  commits: readonly string[],
): Promise<void> {
  await git(["fetch", "--no-tags", "origin", ...commits], repo);
}

/** Whether the checkout holds `sha` as a commit. */
export function hasCommit(repo: GitRepo, sha: string): Promise<boolean> {
  return git(["cat-file", "-e", `${sha}^{commit}`], repo).then(
    () => true,
    () => false,
  );
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
 * Takes the credentials a checkout persisted out of a session's reach.
 * `actions/checkout` leaves its token in the clone's git configuration
 * unless told `persist-credentials: false`. The worker checks the head out
 * into a repository of its own that borrows this checkout's objects, so a
 * command a session runs from the pull request can find this checkout and
 * use a token that writes. The token is removed from every file that sets
 * it: the checkout's config, the files it includes, and each submodule's
 * config. An SSH key cannot be taken away like that, because its file stays
 * on disk, so a checkout that configures one is refused. Throws rather than
 * let a session start while either can still be read.
 */
export async function removeCheckoutCredentials(
  repoDir: string,
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
      throw new StepError(
        "checkout_credentials_persisted",
        "The checkout keeps a git credential a session could read, such as an SSH key; check out over HTTPS with persist-credentials: false",
      );
    }
  }
}
