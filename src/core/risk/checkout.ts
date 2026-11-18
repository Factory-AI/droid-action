import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { GITHUB_SERVER_URL } from "../../github/api/config";
import { describeFailure } from "./plan";
import { RiskError, type RiskPlan } from "./types";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
// How actions/checkout keeps a credential in a clone's configuration: its
// token as a request header, and an SSH key as the command naming the key's
// file.
const TOKEN_HEADER_KEY = /^http\.(.*\.)?extraheader$/;
const SSH_COMMAND_KEY = "core.sshcommand";

type GitRepo = { cwd: string; githubToken?: string };

/**
 * The environment every git command of the risk step runs in: an allow-list,
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
async function git(
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
 * Fetches into the checkout the commits one run reads, which the worker
 * never fetches itself: the base, the pull request's head, the default
 * branch's tip, and the two commits of the earlier verdict a re-check is
 * made against. Returns the default branch's tip, the commit the guidelines
 * are read from, which the pull request cannot move.
 */
export async function fetchRiskRevisions(
  plan: Pick<RiskPlan, "pr" | "baseSha" | "incremental">,
  repo: { repoDir: string; githubToken: string },
): Promise<string> {
  const target = { cwd: repo.repoDir, githubToken: repo.githubToken };
  const policySha = await resolveDefaultBranchTip(target);
  // actions/checkout clones one commit deep by default, and a merge base
  // cannot be found across a shallow boundary.
  const shallow =
    (await git(["rev-parse", "--is-shallow-repository"], target)) === "true";
  await git(
    [
      "fetch",
      "--no-tags",
      ...(shallow ? ["--unshallow"] : []),
      "origin",
      plan.baseSha,
      `refs/pull/${plan.pr}/head`,
      policySha,
    ],
    target,
  );
  if (plan.incremental) {
    const { priorBaseSha, priorHeadSha } = plan.incremental;
    // Fetched apart from the rest, because the remote may no longer have
    // them. The worker then judges the head afresh and reports why, where a
    // failure here would leave the head with no judgment at all.
    await git(
      ["fetch", "--no-tags", "origin", priorBaseSha, priorHeadSha],
      target,
    ).catch((error) => {
      console.warn(
        `The earlier verdict's commits could not be fetched: ${describeFailure(error)}`,
      );
    });
  }
  return policySha;
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
 * unless told `persist-credentials: false`. The worker checks the head out
 * into a repository of its own that borrows this checkout's objects, so a
 * command the judge runs from the pull request can find this checkout and
 * use a token that writes. The token is removed from every file that sets
 * it: the checkout's config, the files it includes, and each submodule's
 * config. An SSH key cannot be taken away like that, because its file stays
 * on disk, so a checkout that configures one is refused. Throws rather than
 * let a judge start while either can still be read.
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
      throw new RiskError(
        "checkout_credentials_persisted",
        "The checkout keeps a git credential the judge could read, such as an SSH key; check out over HTTPS with persist-credentials: false",
      );
    }
  }
}
