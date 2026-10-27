import { spawnSync } from "child_process";

export type GitResult = { status: number; stdout: string; stderr: string };
export type GitRunner = (args: string[]) => GitResult;

export function createGitRunner(cwd: string): GitRunner {
  return (args) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? (result.error ? String(result.error) : ""),
    };
  };
}

export class CommitNotAvailableError extends Error {
  constructor(sha: string) {
    super(
      `commit ${sha} is not available in the checkout; set \`fetchDepth: 0\` on the ` +
        '`checkout: self` step (and clear any "Shallow fetch" override in the pipeline settings).',
    );
    this.name = "CommitNotAvailableError";
  }
}

function run(git: GitRunner, args: string[], what: string): string {
  const result = git(args);
  if (result.status !== 0) {
    throw new Error(`git ${what} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export function ensureCommit(git: GitRunner, sha: string): void {
  if (git(["cat-file", "-e", `${sha}^{commit}`]).status !== 0) {
    throw new CommitNotAvailableError(sha);
  }
}

export function mergeBase(git: GitRunner, a: string, b: string): string {
  return run(git, ["merge-base", a, b], "merge-base").trim();
}

/**
 * Unified diff of the PR as Azure DevOps shows it: the iteration's source
 * commit against the merge base with the target.
 */
export function diffCommits(git: GitRunner, base: string, head: string) {
  return run(
    git,
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      base,
      head,
    ],
    "diff",
  );
}

/**
 * The PR build checks out the merge commit, whose line numbers can differ
 * from the source branch; the review anchors to source-branch lines.
 */
export function checkoutDetached(git: GitRunner, sha: string): void {
  run(git, ["checkout", "--quiet", "--detach", sha], "checkout");
}
