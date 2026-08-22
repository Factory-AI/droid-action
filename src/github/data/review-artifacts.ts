import { execSync } from "child_process";
import { writeFile, mkdir } from "fs/promises";
import type { Octokits } from "../api/client";
import type { ReviewArtifacts } from "../../create-prompt/types";
import { retryWithBackoff } from "../../utils/retry";

const DIFF_MAX_BUFFER = 50 * 1024 * 1024; // 50MB buffer for large diffs

// Default 10MB diff size cap (can be overridden via env var)
const getReviewDiffMaxBytes = (): number => {
  const envValue = process.env.REVIEW_DIFF_MAX_BYTES;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 10 * 1024 * 1024; // 10MB default
};

// Paths to exclude from diff to reduce noise
const NOISE_PATH_PATTERNS = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "/dist/",
  "/build/",
  "/vendor/",
  "/node_modules/",
  ".min.js",
  ".min.css",
  "-generated.",
  ".generated.",
  "/__generated__/",
];

function shouldExcludePath(path: string): boolean {
  return NOISE_PATH_PATTERNS.some((pattern) => path.includes(pattern));
}

function filterDiff(
  diff: string,
  maxBytes: number,
): { diff: string; wasTruncated: boolean; originalBytes: number } {
  const originalBytes = Buffer.byteLength(diff, "utf8");

  if (originalBytes <= maxBytes) {
    return { diff, wasTruncated: false, originalBytes };
  }

  // Try filtering by excluding noise paths first
  const lines = diff.split("\n");
  const filteredLines: string[] = [];
  let currentFile: string | null = null;
  let includeCurrentFile = true;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      // Extract file path from "diff --git a/path b/path"
      const match = line.match(/diff --git a\/(.+?) b\//);
      currentFile = match?.[1] ?? null;
      includeCurrentFile = currentFile ? !shouldExcludePath(currentFile) : true;
    }

    if (includeCurrentFile) {
      filteredLines.push(line);
    }
  }

  const filteredDiff = filteredLines.join("\n");
  const filteredBytes = Buffer.byteLength(filteredDiff, "utf8");

  if (filteredBytes <= maxBytes) {
    console.log(
      `Filtered diff from ${originalBytes} to ${filteredBytes} bytes by excluding noise paths`,
    );
    return { diff: filteredDiff, wasTruncated: false, originalBytes };
  }

  // Still too large, truncate with a marker
  const truncationMarker = `\n\n[DIFF TRUNCATED: Original size ${originalBytes} bytes, filtered size ${filteredBytes} bytes, max allowed ${maxBytes} bytes. Review is based on the first ${maxBytes} bytes of the filtered diff. Large generated files, lockfiles, and vendor directories were excluded.]\n`;
  const truncatedDiff =
    filteredDiff.substring(0, maxBytes - truncationMarker.length) +
    truncationMarker;

  console.log(
    `Truncated diff from ${filteredBytes} to ${maxBytes} bytes (original: ${originalBytes} bytes)`,
  );

  return { diff: truncatedDiff, wasTruncated: true, originalBytes };
}

/**
 * Compute the PR diff and store it on disk.
 *
 * Tries git merge-base first (requires sufficient history). When that
 * fails (e.g. shallow clone without unshallow support) it falls back
 * to `gh pr diff` which always works.
 *
 * Filters out noise paths (lockfiles, generated files) and truncates
 * if the diff exceeds REVIEW_DIFF_MAX_BYTES instead of failing.
 */
export async function computeAndStoreDiff(
  baseRef: string,
  tempDir: string,
  options?: { githubToken?: string; prNumber?: number },
): Promise<string> {
  const promptsDir = `${tempDir}/droid-prompts`;
  await mkdir(promptsDir, { recursive: true });

  let rawDiff: string;
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

    rawDiff = execSync(`git --no-pager diff ${mergeBase}..HEAD`, {
      encoding: "utf8",
      maxBuffer: DIFF_MAX_BUFFER,
    });
  } catch {
    // Fallback: use gh CLI to get the diff (works even with shallow clones)
    // Retry since gh CLI can have transient rate-limit or network failures
    if (options?.githubToken && options?.prNumber) {
      console.log(
        "Git merge-base failed, falling back to gh pr diff for PR diff",
      );
      rawDiff = await retryWithBackoff(
        () =>
          Promise.resolve(
            execSync(`gh pr diff ${options.prNumber}`, {
              encoding: "utf8",
              maxBuffer: DIFF_MAX_BUFFER,
              env: { ...process.env, GH_TOKEN: options.githubToken },
            }),
          ),
        { maxAttempts: 3, initialDelayMs: 3000, maxDelayMs: 15000 },
      );
    } else {
      throw new Error(
        "Git merge-base failed and no fallback credentials provided",
      );
    }
  }

  // Filter and truncate diff if needed
  const maxBytes = getReviewDiffMaxBytes();
  const { diff, wasTruncated, originalBytes } = filterDiff(rawDiff, maxBytes);

  const diffPath = `${promptsDir}/pr.diff`;
  await writeFile(diffPath, diff);

  const finalBytes = Buffer.byteLength(diff, "utf8");
  console.log(
    `Stored PR diff at ${diffPath}: original ${originalBytes} bytes, final ${finalBytes} bytes${wasTruncated ? " (truncated)" : ""}`,
  );

  // Set telemetry outputs if running in GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    const core = await import("@actions/core");
    core.setOutput("diff_original_bytes", originalBytes.toString());
    core.setOutput("diff_final_bytes", finalBytes.toString());
    core.setOutput("diff_was_truncated", wasTruncated.toString());
  }

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
 * Pre-compute all review artifacts (diff, comments, description) in parallel.
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
  const [diffPath, commentsPath, descriptionPath] = await Promise.all([
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
  ]);

  return { diffPath, commentsPath, descriptionPath };
}
