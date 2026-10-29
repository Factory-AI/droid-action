import { describe, expect, test } from "bun:test";
import type { Octokits } from "../../src/github/api/client";
import {
  inspectFixDestination,
  publishReviewFix,
  type FixBinding,
} from "../../src/github/operations/review-fix";

const head = "a".repeat(40),
  fixed = "b".repeat(40);
const binding: FixBinding = {
  owner: "org",
  repo: "repo",
  prNumber: 12,
  actor: "maintainer",
  expectedHead: head,
  mode: "commit",
  allowedPaths: ["src/file.ts"],
};

function fixture(
  options: {
    fork?: boolean;
    protected?: boolean;
    writable?: boolean;
    permission?: string;
    forkPermission?: string;
    branch?: string;
    defaultBranch?: string;
    changedHead?: boolean;
    symlink?: boolean;
    rejectUpdate?: boolean;
    lostUpdate?: boolean;
  } = {},
) {
  const updates: any[] = [],
    refs: any[] = [],
    trees: any[] = [],
    commits: any[] = [],
    prs: any[] = [];
  let refSha = head;
  const rest = {
    repos: {
      getCollaboratorPermissionLevel: async ({ owner }: { owner: string }) => ({
        data: {
          permission:
            owner === "fork"
              ? (options.forkPermission ?? "write")
              : (options.permission ?? "write"),
        },
      }),
      get: async () => ({
        data: {
          permissions: { push: options.writable !== false },
          default_branch: options.defaultBranch ?? "trunk",
        },
      }),
      getBranch: async () => ({
        data: { protected: options.protected ?? false },
      }),
    },
    pulls: {
      get: async () => ({
        data: {
          state: "open",
          head: {
            sha: options.changedHead ? "c".repeat(40) : head,
            ref: options.branch ?? "feature",
            repo: {
              owner: { login: options.fork ? "fork" : "org" },
              name: "repo",
              full_name: options.fork ? "fork/repo" : "org/repo",
            },
          },
          base: { ref: "trunk" },
        },
      }),
      list: async () => ({ data: [] }),
      create: async (args: any) => {
        prs.push(args);
        return { data: { html_url: "https://github.com/org/repo/pull/13" } };
      },
    },
    git: {
      getCommit: async () => ({ data: { tree: { sha: "original-tree" } } }),
      getTree: async () => ({
        data: {
          truncated: false,
          tree: [
            {
              path: "src/file.ts",
              sha: "blob",
              type: "blob",
              mode: options.symlink ? "120000" : "100755",
            },
            {
              path: "unrelated.txt",
              sha: "untouched",
              type: "blob",
              mode: "100644",
            },
          ],
        },
      }),
      getBlob: async () => ({
        data: { content: Buffer.from("old\n").toString("base64") },
      }),
      createBlob: async () => ({ data: { sha: "new-blob" } }),
      createTree: async (args: any) => {
        trees.push(args);
        return { data: { sha: "new-tree" } };
      },
      createCommit: async (args: any) => {
        commits.push(args);
        return { data: { sha: fixed } };
      },
      updateRef: async (args: any) => {
        updates.push(args);
        if (options.lostUpdate) {
          refSha = fixed;
          throw new Error("response lost");
        }
        if (options.rejectUpdate)
          throw Object.assign(new Error("protected branch"), { status: 403 });
        refSha = fixed;
        return { data: {} };
      },
      createRef: async (args: any) => {
        refs.push(args);
        return { data: {} };
      },
      getRef: async () => ({ data: { object: { sha: refSha } } }),
    },
  };
  return {
    client: { rest, graphql: async () => ({}) } as unknown as Octokits,
    updates,
    refs,
    trees,
    commits,
    prs,
  };
}
const proposal = {
  summary: "Fixed the selected condition",
  files: [{ path: "src/file.ts", content: "new\n" }],
};

describe("trusted fix publisher", () => {
  test("writes only selected files, preserves modes and parents, never force pushes", async () => {
    const f = fixture();
    const result = await publishReviewFix(f.client, binding, proposal);
    expect(f.trees[0]).toMatchObject({
      base_tree: "original-tree",
      tree: [
        { path: "src/file.ts", mode: "100755", type: "blob", sha: "new-blob" },
      ],
    });
    expect(f.commits[0].parents).toEqual([head]);
    expect(f.commits[0].author).toBeUndefined();
    expect(f.updates).toEqual([
      {
        owner: "org",
        repo: "repo",
        ref: "heads/feature",
        sha: fixed,
        force: false,
      },
    ]);
    expect(result.body).toContain(fixed);
    expect(result.body).toContain("Tests were not run");
    expect(result.body).toContain("<summary>Diff preview</summary>");
  });
  test.each([{ protected: true }, { fork: true }, { rejectUpdate: true }])(
    "opens a stacked PR without updating protected or fork branches: %o",
    async (options) => {
      const f = fixture(options);
      const result = await publishReviewFix(f.client, binding, proposal);
      expect(f.refs[0]).toMatchObject({
        ref: `refs/heads/droid/fix-12-${fixed.slice(0, 12)}`,
        sha: fixed,
      });
      expect(f.prs[0].base).toBe("feature");
      expect(result.url).toBe("https://github.com/org/repo/pull/13");
      expect(f.updates.every((update) => update.force === false)).toBe(true);
    },
  );
  test("explicit pr mode never updates the source branch", async () => {
    const f = fixture();
    await publishReviewFix(f.client, { ...binding, mode: "pr" }, proposal);
    expect(f.updates).toHaveLength(0);
    expect(f.prs).toHaveLength(1);
  });
  test("lost update response is recovered without duplicating a stacked PR", async () => {
    const f = fixture({ lostUpdate: true });
    await publishReviewFix(f.client, binding, proposal);
    expect(f.updates).toHaveLength(1);
    expect(f.prs).toHaveLength(0);
  });
  test.each([
    { permission: "read" },
    { fork: true, forkPermission: "read" },
    { fork: true, writable: false },
    { branch: "trunk" },
    { changedHead: true },
  ])(
    "refuses unsafe actor/destination/head metadata before writing: %o",
    async (options) => {
      const f = fixture(options);
      await expect(
        publishReviewFix(f.client, binding, proposal),
      ).rejects.toThrow();
      expect(f.updates).toHaveLength(0);
      expect(f.refs).toHaveLength(0);
      expect(f.trees).toHaveLength(0);
    },
  );
  test("the fork's actual default branch is protected even when upstream differs", async () => {
    const f = fixture({
      fork: true,
      branch: "fork-default",
      defaultBranch: "fork-default",
    });
    await expect(inspectFixDestination(f.client, binding)).rejects.toThrow(
      "default branch",
    );
    expect(f.refs).toHaveLength(0);
  });
  test("refuses symlinks instead of dereferencing local paths", async () => {
    const f = fixture({ symlink: true });
    await expect(publishReviewFix(f.client, binding, proposal)).rejects.toThrow(
      "symlinks",
    );
    expect(f.trees).toHaveLength(0);
  });
  test("refuses edits outside selected finding files and secret-bearing content", async () => {
    const f = fixture();
    await expect(
      publishReviewFix(f.client, binding, {
        ...proposal,
        files: [{ path: "unrelated.txt", content: "oops" }],
      }),
    ).rejects.toThrow("selected finding");
    await expect(
      publishReviewFix(f.client, binding, {
        ...proposal,
        files: [{ path: "src/file.ts", content: `ghp_${"a".repeat(36)}` }],
      }),
    ).rejects.toThrow("credentials");
    expect(f.trees).toHaveLength(0);
  });
  test("preserves explicit deletion and does not create an empty commit", async () => {
    const f = fixture();
    await publishReviewFix(f.client, binding, {
      ...proposal,
      files: [{ path: "src/file.ts", content: null }],
    });
    expect(f.trees[0].tree[0].sha).toBeNull();
    const empty = fixture();
    await expect(
      publishReviewFix(empty.client, binding, {
        ...proposal,
        files: [{ path: "src/file.ts", content: "old\n" }],
      }),
    ).rejects.toThrow("No changes");
    expect(empty.commits).toHaveLength(0);
  });
});
