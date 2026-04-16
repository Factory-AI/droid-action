import { execSync } from "child_process";
import { writeFile, mkdir } from "fs/promises";
import type { Octokits } from "../api/client";
import type { ReviewArtifacts } from "../../create-prompt/types";

const DIFF_MAX_BUFFER = 50 * 1024 * 1024; // 50MB buffer for large diffs

/**
 * Compute the PR diff and store it on disk.
 *
 * Tries git merge-base first (requires sufficient history). When that
 * fails (e.g. shallow clone without unshallow support) it falls back
 * to `gh pr diff` which always works.
 */
export async function computeAndStoreDiff(
  baseRef: string,
  tempDir: string,
  options?: { githubToken?: string; prNumber?: number },
): Promise<string> {
  const promptsDir = `${tempDir}/droid-prompts`;
  await mkdir(promptsDir, { recursive: true });

  let diff: string;
  try {
    // Unshallow the repo if it's a shallow clone (needed for merge-base)
    try {
      execSync("git rev-parse --is-shallow-repository", {
        encoding: "utf8",
        stdio: "pipe",
      }).trim() === "true" &&
        execSync("git fetch --unshallow", {
          encoding: "utf8",
          stdio: "pipe",
        });
      console.log("Unshallowed repository");
    } catch {
      console.log("Repository already has full history");
    }

    // Fetch the base branch (it may not exist locally yet)
    try {
      execSync(`git fetch origin ${baseRef}:refs/remotes/origin/${baseRef}`, {
        encoding: "utf8",
        stdio: "pipe",
      });
      console.log(`Fetched base branch: ${baseRef}`);
    } catch {
      console.log(`Base branch fetch skipped (may already exist): ${baseRef}`);
    }

    const mergeBase = execSync(
      `git merge-base HEAD refs/remotes/origin/${baseRef}`,
      { encoding: "utf8" },
    ).trim();

    diff = execSync(`git --no-pager diff ${mergeBase}..HEAD`, {
      encoding: "utf8",
      maxBuffer: DIFF_MAX_BUFFER,
    });
  } catch {
    // Fallback: use gh CLI to get the diff (works even with shallow clones)
    if (options?.githubToken && options?.prNumber) {
      console.log(
        "Git merge-base failed, falling back to gh pr diff for PR diff",
      );
      diff = execSync(`gh pr diff ${options.prNumber}`, {
        encoding: "utf8",
        maxBuffer: DIFF_MAX_BUFFER,
        env: { ...process.env, GH_TOKEN: options.githubToken },
      });
    } else {
      throw new Error(
        "Git merge-base failed and no fallback credentials provided",
      );
    }
  }

  const diffPath = `${promptsDir}/pr.diff`;
  await writeFile(diffPath, diff);
  console.log(`Stored PR diff (${diff.length} bytes) at ${diffPath}`);
  return diffPath;
}

export async function fetchAndStoreComments(
  octokit: Octokits,
  owner: string,
  repo: string,
  prNumber: number,
  tempDir: string,
): Promise<string> {
  const promptsDir = `${tempDir}/droid-prompts`;
  await mkdir(promptsDir, { recursive: true });

  const [issueComments, reviewComments] = await Promise.all([
    octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    }),
    octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);

  const comments = {
    issueComments: issueComments.data,
    reviewComments: reviewComments.data,
  };

  const commentsPath = `${promptsDir}/existing_comments.json`;
  await writeFile(commentsPath, JSON.stringify(comments, null, 2));
  console.log(
    `Stored existing comments (${issueComments.data.length} issue, ${reviewComments.data.length} review) at ${commentsPath}`,
  );
  return commentsPath;
}

export async function storeDescription(
  title: string,
  body: string,
  tempDir: string,
): Promise<string> {
  const promptsDir = `${tempDir}/droid-prompts`;
  await mkdir(promptsDir, { recursive: true });

  const content = `# ${title}\n\n${body}`;
  const descriptionPath = `${promptsDir}/pr_description.txt`;
  await writeFile(descriptionPath, content);
  console.log(
    `Stored PR description (${content.length} bytes) at ${descriptionPath}`,
  );
  return descriptionPath;
}

/**
 * Pre-read all changed files and store them in a single artifact file.
 * This eliminates the need for the LLM to read files one-by-one during review.
 */
export async function computeAndStoreChangedFiles(
  baseRef: string,
  tempDir: string,
): Promise<string> {
  const promptsDir = `${tempDir}/droid-prompts`;
  await mkdir(promptsDir, { recursive: true });

  let changedFiles: string[];
  try {
    const mergeBase = execSync(
      `git merge-base HEAD refs/remotes/origin/${baseRef}`,
      { encoding: "utf8" },
    ).trim();
    const output = execSync(
      `git --no-pager diff --name-only ${mergeBase}..HEAD`,
      { encoding: "utf8" },
    );
    changedFiles = output
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);
  } catch {
    console.log("Failed to get changed files list, skipping pre-read");
    const emptyPath = `${promptsDir}/changed_files.txt`;
    await writeFile(emptyPath, "");
    return emptyPath;
  }

  const sections: string[] = [];
  for (const filePath of changedFiles) {
    try {
      const content = execSync(`git show HEAD:${filePath}`, {
        encoding: "utf8",
        maxBuffer: 5 * 1024 * 1024,
      });
      sections.push(
        `=== FILE: ${filePath} ===\n${content}\n=== END: ${filePath} ===`,
      );
    } catch {
      sections.push(`=== FILE: ${filePath} ===\n[binary or deleted file]\n=== END: ${filePath} ===`);
    }
  }

  const changedFilesPath = `${promptsDir}/changed_files.txt`;
  await writeFile(changedFilesPath, sections.join("\n\n"));
  console.log(
    `Stored ${changedFiles.length} changed file contents (${sections.join("").length} bytes) at ${changedFilesPath}`,
  );
  return changedFilesPath;
}

/**
 * Pre-compute all review artifacts (diff, comments, description, changed files) in parallel.
 */
export async function computeReviewArtifacts(opts: {
  baseRef: string;
  tempDir: string;
  octokit: Octokits;
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  githubToken?: string;
}): Promise<ReviewArtifacts> {
  const [diffPath, commentsPath, descriptionPath, changedFilesPath] =
    await Promise.all([
      computeAndStoreDiff(opts.baseRef, opts.tempDir, {
        githubToken: opts.githubToken,
        prNumber: opts.prNumber,
      }),
      fetchAndStoreComments(
        opts.octokit,
        opts.owner,
        opts.repo,
        opts.prNumber,
        opts.tempDir,
      ),
      storeDescription(opts.title, opts.body, opts.tempDir),
      computeAndStoreChangedFiles(opts.baseRef, opts.tempDir),
    ]);

  return { diffPath, commentsPath, descriptionPath, changedFilesPath };
}
