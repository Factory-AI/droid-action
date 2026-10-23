import { execSync } from "child_process";
import { retryWithBackoff } from "../../utils/retry";

/** Ref a fork PR's head commit is fetched to. Nothing is checked out from it. */
export function forkHeadRef(prNumber: number): string {
  return `refs/remotes/droid/pr-${prNumber}-head`;
}

/**
 * Makes the PR's head commit available for the diff and the review, and
 * returns the git revision that holds it: `HEAD` when the PR is checked out,
 * the fork head ref for a fork, or null when only the API diff can be used.
 *
 * A same-repository PR is checked out, since only people with write access can
 * push its branch. A fork PR never is: its files would sit in the working
 * directory of a job holding the workflow's secrets, where tools load project
 * files (bunfig.toml preloads, .env, .factory hooks and MCP servers). Its
 * commits are fetched to a ref instead, which only writes git objects.
 */
export async function preparePullRequestHead({
  prNumber,
  isFork,
  githubToken,
}: {
  prNumber: number;
  isFork: boolean;
  githubToken: string;
}): Promise<string | null> {
  if (isFork) {
    return fetchForkHead(prNumber, githubToken);
  }

  console.log(`Checking out PR #${prNumber} branch for diff computation...`);
  try {
    await retryWithBackoff(
      async () => {
        execSync("git reset --hard HEAD", { encoding: "utf8", stdio: "pipe" });
        execSync(`gh pr checkout ${prNumber}`, {
          encoding: "utf8",
          stdio: "pipe",
          env: { ...process.env, GH_TOKEN: githubToken },
        });
        const branchName = execSync("git rev-parse --abbrev-ref HEAD", {
          encoding: "utf8",
        }).trim();
        console.log(`Successfully checked out PR branch: ${branchName}`);
      },
      { maxAttempts: 3, initialDelayMs: 3000, maxDelayMs: 15000 },
    );
  } catch (e) {
    console.error(`Failed to checkout PR branch after retries: ${e}`);
    throw new Error(`Failed to checkout PR #${prNumber} branch for review`);
  }
  return "HEAD";
}

/**
 * A git command authenticated by gh, as gh does for its own git commands, so
 * it also works when actions/checkout did not persist a credential.
 */
export function ghAuthenticatedGit(args: string): string {
  return `git -c credential.helper= -c "credential.helper=!gh auth git-credential" ${args}`;
}

function fetchForkHead(prNumber: number, githubToken: string): string | null {
  const ref = forkHeadRef(prNumber);
  console.log(
    `PR #${prNumber} comes from a fork, so its code is not checked out. Fetching its commits to ${ref}.`,
  );
  try {
    execSync(
      ghAuthenticatedGit(
        `fetch --no-tags origin +refs/pull/${prNumber}/head:${ref}`,
      ),
      {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, GH_TOKEN: githubToken },
      },
    );
    return ref;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `Could not fetch PR #${prNumber}'s commits, so the review uses the diff from the GitHub API: ${message}`,
    );
    return null;
  }
}

/** The fork head ref when an earlier step of this job fetched it. */
export function fetchedForkHeadRef(prNumber: number): string | null {
  const ref = forkHeadRef(prNumber);
  try {
    execSync(`git rev-parse --verify --quiet ${ref}^{commit}`, {
      encoding: "utf8",
      stdio: "pipe",
    });
    return ref;
  } catch {
    return null;
  }
}
