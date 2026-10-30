import type { Octokits } from "../api/client";
import { retryWithBackoff } from "../../utils/retry";
import { redactCredentials } from "../../utils/redact-credentials";
import {
  assertFixPath,
  chooseFixTarget,
  fixProposalSchema,
  type FixMode,
  type FixProposal,
} from "../../core/review/fix";
import { details, fenced, prose } from "../../core/review/render";

const retryOptions = { initialDelayMs: 1000, maxDelayMs: 4000 };
export type FixBinding = {
  owner: string;
  repo: string;
  prNumber: number;
  actor: string;
  expectedHead: string;
  mode: FixMode;
  allowedPaths: string[];
};

/** Rechecked in the trusted publisher, independent of prepare's optional actor bypass. */
export async function inspectFixDestination(
  octokit: Octokits,
  binding: FixBinding,
) {
  const { owner, repo, prNumber, actor, expectedHead } = binding;
  const permission = await retryWithBackoff(
    () =>
      octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username: actor,
      }),
    retryOptions,
  );
  if (!["admin", "write", "maintain"].includes(permission.data.permission)) {
    throw new Error(
      "@droid fix requires verified write access for the person requesting it",
    );
  }
  const pr = (
    await retryWithBackoff(
      () => octokit.rest.pulls.get({ owner, repo, pull_number: prNumber }),
      retryOptions,
    )
  ).data;
  if (pr.state !== "open" || pr.head.sha !== expectedHead || !pr.head.repo) {
    throw new Error(
      "The PR is closed, unavailable, or its head changed. Comment @droid fix again on the latest commit.",
    );
  }
  const headOwner = pr.head.repo.owner.login;
  const headRepo = pr.head.repo.name;
  const destination = (
    await retryWithBackoff(
      () => octokit.rest.repos.get({ owner: headOwner, repo: headRepo }),
      retryOptions,
    )
  ).data;
  const fork =
    pr.head.repo.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase();
  if (fork) {
    const headPermission = await retryWithBackoff(
      () =>
        octokit.rest.repos.getCollaboratorPermissionLevel({
          owner: headOwner,
          repo: headRepo,
          username: actor,
        }),
      retryOptions,
    );
    if (
      !["admin", "write", "maintain"].includes(headPermission.data.permission)
    ) {
      throw new Error(
        "Droid cannot fix this fork: the requesting actor has no verified write access to the fork repository",
      );
    }
  }
  const branch = (
    await retryWithBackoff(
      () =>
        octokit.rest.repos.getBranch({
          owner: headOwner,
          repo: headRepo,
          branch: pr.head.ref,
        }),
      retryOptions,
    )
  ).data;
  const target = chooseFixTarget({
    mode: binding.mode,
    writable: destination.permissions?.push === true,
    protected: branch.protected,
    headBranch: pr.head.ref,
    defaultBranch: destination.default_branch,
    fork,
  });
  return {
    pr,
    headOwner,
    headRepo,
    target,
    fork,
    repositoryId: destination.node_id,
  };
}

/** Fetch immutable source through the API. Fork code is never checked out or executed. */
export async function fetchFixSources(
  octokit: Octokits,
  binding: FixBinding,
): Promise<{
  sources: Array<{ path: string; content: string }>;
  skippedPaths: string[];
}> {
  const { headOwner: owner, headRepo: repo } = await inspectFixDestination(
    octokit,
    binding,
  );
  const fetched = await Promise.all(
    [...new Set(binding.allowedPaths)].map(async (path) => {
      assertFixPath(path);
      let result;
      try {
        result = (
          await retryWithBackoff(
            () =>
              octokit.rest.repos.getContent({
                owner,
                repo,
                path,
                ref: binding.expectedHead,
              }),
            {
              ...retryOptions,
              shouldRetry: (error) =>
                !("status" in error && error.status === 404),
            },
          )
        ).data;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          error.status === 404
        )
          return { path, missing: true as const };
        throw error;
      }
      if (
        Array.isArray(result) ||
        result.type !== "file" ||
        !("content" in result) ||
        result.size > 1024 * 1024
      ) {
        throw new Error("Fix source must be a regular file smaller than 1 MiB");
      }
      const content = Buffer.from(result.content, "base64").toString("utf8");
      if (redactCredentials(content) !== content)
        throw new Error(
          "Fix source requires credential redaction; refusing a destructive replacement",
        );
      return { path, content, missing: false as const };
    }),
  );
  return {
    sources: fetched.flatMap((file) =>
      file.missing ? [] : [{ path: file.path, content: file.content }],
    ),
    skippedPaths: fetched
      .filter((file) => file.missing)
      .map((file) => file.path),
  };
}

export type PublishedFix = { sha: string; url?: string; body: string };
export async function publishReviewFix(
  octokit: Octokits,
  binding: FixBinding,
  raw: unknown,
): Promise<PublishedFix> {
  const proposal = fixProposalSchema.parse(raw);
  const destination = await inspectFixDestination(octokit, binding);
  const { headOwner: owner, headRepo: repo, pr } = destination;
  const allowed = new Set(binding.allowedPaths);
  const paths = new Set<string>();
  for (const file of proposal.files) {
    assertFixPath(file.path);
    if (!allowed.has(file.path) || paths.has(file.path))
      throw new Error("Fix may modify each selected finding file only once");
    if (
      file.content !== null &&
      redactCredentials(file.content) !== file.content
    )
      throw new Error(
        "Fix output contains credentials; refusing to publish it",
      );
    paths.add(file.path);
  }
  const commit = (
    await retryWithBackoff(
      () =>
        octokit.rest.git.getCommit({
          owner,
          repo,
          commit_sha: binding.expectedHead,
        }),
      retryOptions,
    )
  ).data;
  const tree = (
    await retryWithBackoff(
      () =>
        octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: commit.tree.sha,
          recursive: "1",
        }),
      retryOptions,
    )
  ).data;
  if (tree.truncated)
    throw new Error(
      "The repository tree is too large to safely publish this fix",
    );
  const entries: Array<{
    path: string;
    mode: "100644" | "100755";
    type: "blob";
    sha: string | null;
  }> = [];
  const previews: string[] = [];
  for (const file of proposal.files) {
    const original = tree.tree.find((entry) => entry.path === file.path);
    if (
      !original?.sha ||
      original.type !== "blob" ||
      (original.mode !== "100644" && original.mode !== "100755")
    ) {
      throw new Error(
        "Fix cannot modify symlinks, submodules, or files outside the expected PR tree",
      );
    }
    const oldBlob = (
      await retryWithBackoff(
        () =>
          octokit.rest.git.getBlob({ owner, repo, file_sha: original.sha! }),
        retryOptions,
      )
    ).data;
    const oldText = Buffer.from(oldBlob.content, "base64").toString("utf8");
    if (redactCredentials(oldText) !== oldText)
      throw new Error(
        "Fix source requires credential redaction; refusing a destructive replacement",
      );
    if (file.content === oldText) continue;
    let sha: string | null = null;
    if (file.content !== null) {
      sha = (
        await retryWithBackoff(
          () =>
            octokit.rest.git.createBlob({
              owner,
              repo,
              content: file.content!,
              encoding: "utf-8",
            }),
          retryOptions,
        )
      ).data.sha;
    }
    entries.push({ path: file.path, mode: original.mode, type: "blob", sha });
    previews.push(diffPreview(file.path, oldText, file.content));
  }
  if (!entries.length)
    throw new Error("No changes were proposed for the selected findings");
  const newTree = (
    await retryWithBackoff(
      () =>
        octokit.rest.git.createTree({
          owner,
          repo,
          base_tree: commit.tree.sha,
          tree: entries,
        }),
      retryOptions,
    )
  ).data;
  const fixedCommit = (
    await retryWithBackoff(
      () =>
        octokit.rest.git.createCommit({
          owner,
          repo,
          tree: newTree.sha,
          parents: [binding.expectedHead],
          message:
            "fix(review): address Droid findings\n\nCo-authored-by: factory-droid[bot] <138933559+factory-droid[bot]@users.noreply.github.com>",
        }),
      retryOptions,
    )
  ).data;
  // No shell push, force update, default-branch write, or model-selected destination.
  const fresh = await inspectFixDestination(octokit, binding);
  let url: string | undefined;
  if (fresh.target === "commit") {
    if (!fresh.repositoryId)
      throw new Error(
        "Atomic expected-head publication is unavailable for this repository",
      );
    try {
      // beforeOid is a server-side compare-and-swap, including concurrent rewinds.
      // REST updateRef(force:false) alone can resurrect discarded ancestor history.
      const published = await octokit.graphql<{
        updateRefs: { clientMutationId: string | null } | null;
      }>(
        `mutation PublishReviewFix($input: UpdateRefsInput!) {
          updateRefs(input: $input) { clientMutationId }
        }`,
        {
          input: {
            repositoryId: fresh.repositoryId,
            refUpdates: [
              {
                name: `refs/heads/${pr.head.ref}`,
                beforeOid: binding.expectedHead,
                afterOid: fixedCommit.sha,
                force: false,
              },
            ],
          },
        },
      );
      if (!published.updateRefs)
        throw new Error("Atomic expected-head publication is unsupported");
    } catch (error) {
      // A lost response can mean the update already succeeded.
      const current = (
        await retryWithBackoff(
          () =>
            octokit.rest.git.getRef({
              owner,
              repo,
              ref: `heads/${pr.head.ref}`,
            }),
          retryOptions,
        )
      ).data;
      if (current.object.sha !== fixedCommit.sha) {
        const stillCurrent = await inspectFixDestination(octokit, binding);
        if (!isPermissionFailure(error)) throw error;
        url = await createStackedFix(
          octokit,
          binding,
          stillCurrent,
          fixedCommit.sha,
          proposal,
        );
      }
    }
  } else {
    url = await createStackedFix(
      octokit,
      binding,
      fresh,
      fixedCommit.sha,
      proposal,
    );
  }
  const body = [
    `Droid applied the selected fixes${url ? ` in [a stacked PR](${url})` : ` in commit \`${fixedCommit.sha}\``}.`,
    prose(redactCredentials(proposal.summary)),
    "⚠️ Tests were not run. The restricted fix session cannot execute repository code. Run the PR's checks before merging.",
    details(
      "Diff preview",
      fenced(previews.join("\n\n").slice(0, 16000), "diff"),
    ),
  ].join("\n\n");
  return {
    sha: fixedCommit.sha,
    ...(url ? { url } : {}),
    body: redactCredentials(body),
  };
}

function isPermissionFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    Number(error.status) === 403
  );
}
function diffPreview(
  path: string,
  before: string,
  after: string | null,
): string {
  const oldLines = before.split("\n");
  const newLines = (after ?? "").split("\n");
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  )
    start++;
  let oldEnd = oldLines.length,
    newEnd = newLines.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  return `--- a/${path}\n+++ ${after === null ? "/dev/null" : `b/${path}`}\n@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@\n${oldLines
    .slice(start, oldEnd)
    .map((line) => `-${line}`)
    .join("\n")}\n${newLines
    .slice(start, newEnd)
    .map((line) => `+${line}`)
    .join("\n")}`;
}
async function createStackedFix(
  octokit: Octokits,
  binding: FixBinding,
  destination: Awaited<ReturnType<typeof inspectFixDestination>>,
  sha: string,
  proposal: FixProposal,
): Promise<string> {
  const { headOwner: owner, headRepo: repo, pr } = destination;
  const branch = `droid/fix-${binding.prNumber}-${sha.slice(0, 12)}`;
  // Never retry a ref creation blindly. A collision is reusable only for this exact commit.
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
  } catch (error) {
    const current = (
      await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })
    ).data;
    if (current.object.sha !== sha) throw error;
  }
  const existing = (
    await retryWithBackoff(
      () =>
        octokit.rest.pulls.list({
          owner,
          repo,
          state: "open",
          head: `${owner}:${branch}`,
          base: pr.head.ref,
        }),
      retryOptions,
    )
  ).data;
  if (existing[0]) return existing[0].html_url;
  const body = `Fixes selected Droid findings from ${binding.owner}/${binding.repo}#${binding.prNumber}.\n\n${prose(redactCredentials(proposal.summary))}\n\n⚠️ Tests were not run. Run the PR's checks before merging.\n\nBased on \`${binding.expectedHead}\`.`;
  try {
    return (
      await octokit.rest.pulls.create({
        owner,
        repo,
        head: branch,
        base: pr.head.ref,
        title: `fix(review): address findings from #${binding.prNumber}`,
        body,
      })
    ).data.html_url;
  } catch (error) {
    const recovered = (
      await octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
        head: `${owner}:${branch}`,
        base: pr.head.ref,
      })
    ).data[0];
    if (recovered) return recovered.html_url;
    throw new Error(
      `The fix branch ${branch} was created at ${sha}, but the stacked PR could not be opened. ${redactCredentials(error instanceof Error ? error.message : String(error))}`,
    );
  }
}
