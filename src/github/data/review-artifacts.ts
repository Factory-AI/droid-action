import { execSync } from "child_process";
import { writeFile, mkdir, readFile } from "fs/promises";
import { createHash } from "crypto";
import type { Octokits } from "../api/client";
import type { ReviewArtifacts } from "../../create-prompt/types";
import { retryWithBackoff } from "../../utils/retry";
import { ghAuthenticatedGit } from "./pr-checkout";
import {
  reviewConfigFromEnvironment,
  shouldIgnoreReviewPath,
} from "../../core/review/config";
import {
  changedFindingCandidates,
  identicalReviewDiffSkipReason,
} from "../../core/review/incremental";
import {
  fetchImmutableReviewDiff,
  finishReviewLifecycle,
  readReviewLifecycle,
  saveReviewLifecycle,
  stateFindings,
} from "../operations/review-lifecycle";
import { redactCredentials } from "../../utils/redact-credentials";
import {
  normalizePatchPath,
  pathsFromDiffHeader,
} from "../../core/review/validated/diff";

const DIFF_MAX_BUFFER = 50 * 1024 * 1024; // 50MB buffer for large diffs

/**
 * Compute the PR diff and store it on disk.
 *
 * Tries git merge-base first (requires sufficient history). When that
 * fails (e.g. shallow clone without unshallow support) it falls back
 * to `gh pr diff` which always works.
 *
 * `headRevision` is the git revision holding the PR head (default `HEAD`).
 * Null means the head commit is not available locally, so only
 * `gh pr diff` is tried.
 */
export async function computeAndStoreDiff(
  baseRef: string,
  tempDir: string,
  options?: {
    githubToken?: string;
    prNumber?: number;
    headRevision?: string | null;
    incrementalBaseSha?: string;
    onRangeSelected?: (base: string, incremental: boolean) => void;
  },
): Promise<string> {
  const promptsDir = `${tempDir}/droid-prompts`;
  await mkdir(promptsDir, { recursive: true });
  const headRevision =
    options?.headRevision === undefined ? "HEAD" : options.headRevision;

  let diff: string;
  try {
    if (headRevision === null) {
      throw new Error("PR head commit is not available locally");
    }
    const githubToken = options?.githubToken;
    const fetchCommand = (args: string) =>
      githubToken ? ghAuthenticatedGit(args) : `git ${args}`;
    const fetchEnv = githubToken
      ? { ...process.env, GH_TOKEN: githubToken }
      : process.env;

    // Unshallow the repo if it's a shallow clone (needed for merge-base)
    try {
      execSync("git rev-parse --is-shallow-repository", {
        encoding: "utf8",
        stdio: "pipe",
      }).trim() === "true" &&
        execSync(fetchCommand("fetch --unshallow"), {
          encoding: "utf8",
          stdio: "pipe",
          env: fetchEnv,
        });
      console.log("Unshallowed repository");
    } catch {
      console.log("Repository already has full history");
    }

    // Fetch the base branch (it may not exist locally yet)
    try {
      execSync(
        fetchCommand(`fetch origin ${baseRef}:refs/remotes/origin/${baseRef}`),
        { encoding: "utf8", stdio: "pipe", env: fetchEnv },
      );
      console.log(`Fetched base branch: ${baseRef}`);
    } catch {
      console.log(`Base branch fetch skipped (may already exist): ${baseRef}`);
    }

    let incrementalBase: string | undefined;
    if (
      options?.incrementalBaseSha &&
      /^[a-f0-9]{7,64}$/i.test(options.incrementalBaseSha)
    ) {
      try {
        execSync(`git cat-file -e ${options.incrementalBaseSha}^{commit}`, {
          encoding: "utf8",
          stdio: "pipe",
        });
        incrementalBase = options.incrementalBaseSha;
      } catch {
        console.log(
          "The previous reviewed commit is unavailable; reviewing the full PR.",
        );
      }
    }
    const mergeBase =
      incrementalBase ??
      execSync(
        `git merge-base ${headRevision} refs/remotes/origin/${baseRef}`,
        { encoding: "utf8" },
      ).trim();

    diff = execSync(`git --no-pager diff ${mergeBase}..${headRevision}`, {
      encoding: "utf8",
      maxBuffer: DIFF_MAX_BUFFER,
    });
    options?.onRangeSelected?.(mergeBase, !!incrementalBase);
  } catch {
    // Fallback: use gh CLI to get the diff (works even with shallow clones)
    // Retry since gh CLI can have transient rate-limit or network failures
    if (options?.githubToken && options?.prNumber) {
      console.log(
        "Git merge-base failed, falling back to gh pr diff for PR diff",
      );
      diff = await retryWithBackoff(
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
      options?.onRangeSelected?.("", false);
    } else {
      throw new Error(
        "Git merge-base failed and no fallback credentials provided",
      );
    }
  }

  const diffPath = `${promptsDir}/pr.diff`;
  await writeFile(diffPath, redactCredentials(diff));
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
  for (let page = 2, count = issueComments.data.length; count === 100; page++) {
    const next = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
      page,
    });
    count = next.data.length;
    issueComments.data.push(...next.data);
  }
  for (
    let page = 2, count = reviewComments.data.length;
    count === 100;
    page++
  ) {
    const next = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    count = next.data.length;
    reviewComments.data.push(...next.data);
  }

  const comments = {
    issueComments: issueComments.data,
    reviewComments: reviewComments.data,
  };

  const commentsPath = `${promptsDir}/existing_comments.json`;
  await writeFile(
    commentsPath,
    redactCredentials(JSON.stringify(comments, null, 2)),
  );
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
  await writeFile(descriptionPath, redactCredentials(content));
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
  headRevision?: string | null;
  incrementalBaseSha?: string;
}): Promise<ReviewArtifacts> {
  let actualBase = "";
  let incrementalUsed = false;
  const [diffPath, commentsPath, descriptionPath] = await Promise.all([
    computeAndStoreDiff(opts.baseRef, opts.tempDir, {
      githubToken: opts.githubToken,
      prNumber: opts.prNumber,
      headRevision: opts.headRevision,
      incrementalBaseSha: opts.incrementalBaseSha,
      onRangeSelected: (base, incremental) => {
        actualBase = base;
        incrementalUsed = incremental;
      },
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
  // Tests and legacy callers may provide a virtual filesystem writer.
  let rawDiff: string | undefined;
  try {
    rawDiff = await readFile(diffPath, "utf8");
  } catch {
    return { diffPath, commentsPath, descriptionPath };
  }
  const config = reviewConfigFromEnvironment();
  const skipped: Array<{ path: string; reason: string }> = [];
  const reviewed: string[] = [];
  const filtered = rawDiff
    .split(/(?=^diff --git )/m)
    .filter((block) => {
      const headers = block.split("\n@@", 1)[0]!;
      const oldHeader = /^--- (.+)$/m.exec(headers)?.[1];
      const newHeader = /^\+\+\+ (.+)$/m.exec(headers)?.[1];
      const paths = pathsFromDiffHeader(headers.split("\n", 1)[0]!);
      const filePath =
        (newHeader ? normalizePatchPath(newHeader) : paths.newPath) ??
        (oldHeader ? normalizePatchPath(oldHeader) : paths.oldPath);
      if (!filePath) return true;
      if (shouldIgnoreReviewPath(filePath, config)) {
        skipped.push({
          path: filePath,
          reason: "ignored by review_ignore_paths",
        });
        return false;
      }
      reviewed.push(filePath);
      return true;
    })
    .join("");
  await writeFile(diffPath, filtered);
  await writeFile(
    `${opts.tempDir}/droid-prompts/review_files.json`,
    JSON.stringify({ reviewed, skipped }),
  );
  const lifecycle = await readReviewLifecycle();
  if (lifecycle) {
    lifecycle.base = actualBase || lifecycle.base;
    if (!incrementalUsed) lifecycle.incrementalBaseSha = undefined;
    const previous = stateFindings(lifecycle.state);
    let priorDiff = incrementalUsed ? rawDiff : undefined;
    if (
      priorDiff === undefined &&
      /^[a-f0-9]{7,64}$/i.test(lifecycle.state.head)
    ) {
      try {
        priorDiff = await fetchImmutableReviewDiff(opts.octokit, {
          owner: opts.owner,
          repo: opts.repo,
          base: lifecycle.state.head,
          head: lifecycle.head,
          direct: true,
        });
      } catch {
        /* No fixed eligibility without the actual prior-head diff. */
      }
    }
    const changedFindings =
      priorDiff === undefined
        ? []
        : changedFindingCandidates(previous, priorDiff);
    lifecycle.eligibleFixedIds = changedFindings.map((finding) => finding.id);
    await writeFile(
      `${opts.tempDir}/droid-prompts/review_prior_findings.json`,
      redactCredentials(
        JSON.stringify(
          {
            head: lifecycle.head,
            reviewedHead: lifecycle.state.head,
            openFindings: previous.filter(
              (finding) =>
                finding.state !== "resolved" && finding.state !== "dismissed",
            ),
            changedFindings,
            eligibleFixedIds: lifecycle.eligibleFixedIds,
          },
          null,
          2,
        ),
      ),
    );
    const diffHash = createHash("sha256").update(rawDiff).digest("hex");
    const skipReason = identicalReviewDiffSkipReason({
      full: lifecycle.full,
      incrementalUsed,
      empty: !rawDiff.trim(),
      hash: diffHash,
      previousHash: lifecycle.state.diffHash,
      previousHead: lifecycle.state.head,
    });
    if (skipReason) {
      lifecycle.skipReason = skipReason;
      await saveReviewLifecycle(lifecycle);
      await finishReviewLifecycle({
        octokit: opts.octokit,
        run: lifecycle,
        input: {
          state: "skipped",
          skipReason: lifecycle.skipReason,
          head: lifecycle.head,
          previousHead: lifecycle.state.head,
          previousBody: lifecycle.previousBody,
        },
      });
    }
  }
  return { diffPath, commentsPath, descriptionPath };
}
