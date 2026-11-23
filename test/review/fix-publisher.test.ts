import { describe, expect, test } from "bun:test";
import type { Octokits } from "../../src/github/api/client";
import {
  inspectFixDestination,
  fetchFixSources,
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
    source?: string;
    missingPaths?: string[];
    sourceStatus?: number;
    sourceTransport?: boolean;
    race?: "rewind" | "forward";
    unsupportedCAS?: boolean;
    missingRepositoryId?: boolean;
  } = {},
) {
  const updates: any[] = [],
    refs: any[] = [],
    trees: any[] = [],
    commits: any[] = [],
    prs: any[] = [],
    mutations: any[] = [],
    blobs: any[] = [];
  let refSha = head;
  const racedHead = options.race === "rewind" ? "c".repeat(40) : "d".repeat(40);
  const race = () => {
    if (options.race) refSha = racedHead;
  };
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
          node_id: options.missingRepositoryId ? undefined : "repository-node",
          permissions: { push: options.writable !== false },
          default_branch: options.defaultBranch ?? "trunk",
        },
      }),
      getBranch: async () => ({
        data: { protected: options.protected ?? false },
      }),
      getContent: async ({ path }: { path: string }) => {
        if (options.sourceTransport) throw new Error("Transport unavailable");
        if (options.missingPaths?.includes(path) || options.sourceStatus)
          throw Object.assign(new Error("Source unavailable"), {
            status: options.sourceStatus ?? 404,
          });
        const content = options.source ?? "old\n";
        return {
          data: {
            type: "file",
            size: Buffer.byteLength(content),
            content: Buffer.from(content).toString("base64"),
          },
        };
      },
    },
    pulls: {
      get: async () => ({
        data: {
          state: "open",
          head: {
            sha: options.changedHead ? "c".repeat(40) : refSha,
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
        data: {
          content: Buffer.from(options.source ?? "old\n").toString("base64"),
        },
      }),
      createBlob: async (args: any) => {
        blobs.push(args);
        return { data: { sha: "new-blob" } };
      },
      createTree: async (args: any) => {
        trees.push(args);
        return { data: { sha: "new-tree" } };
      },
      createCommit: async (args: any) => {
        commits.push(args);
        return { data: { sha: fixed } };
      },
      updateRef: async (args: any) => {
        race();
        updates.push(args);
        if (options.race === "forward")
          throw Object.assign(new Error("not fast forward"), { status: 422 });
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
    client: {
      rest,
      graphql: async (query: string, variables: any) => {
        if (!query.includes("updateRefs")) return {};
        mutations.push(variables);
        race();
        if (options.unsupportedCAS)
          throw new Error("Unknown mutation updateRefs");
        const update = variables.input.refUpdates[0];
        if (update.beforeOid !== refSha)
          throw new Error("Expected head changed");
        if (options.rejectUpdate)
          throw Object.assign(new Error("protected branch"), { status: 403 });
        refSha = update.afterOid;
        if (options.lostUpdate) throw new Error("response lost");
        return { updateRefs: { clientMutationId: null } };
      },
    } as unknown as Octokits,
    updates,
    refs,
    trees,
    commits,
    prs,
    mutations,
    blobs,
    currentHead: () => refSha,
    racedHead,
  };
}
const proposal = {
  summary: "Fixed the selected condition",
  files: [{ path: "src/file.ts", content: "new\n" }],
};

describe("trusted fix publisher", () => {
  test.each([
    `const token = "ghp_${"x".repeat(36)}";\nconst value = 1;\n`,
    "const key = `-----BEGIN PRIVATE KEY-----\nFAKE TEST FIXTURE ONLY\n-----END PRIVATE KEY-----`;\nconst value = 1;\n",
  ])(
    "prefix safety refuses redacted original fixtures during preparation",
    async (source) => {
      const prepared = fixture({ source });
      await expect(fetchFixSources(prepared.client, binding)).rejects.toThrow(
        "redact",
      );
    },
  );
  test.each([
    `const token = "ghp_${"x".repeat(36)}";\nconst value = 1;\n`,
    "const key = `-----BEGIN PRIVATE KEY-----\nFAKE TEST FIXTURE ONLY\n-----END PRIVATE KEY-----`;\nconst value = 1;\n",
  ])(
    "prefix safety trusted publisher independently refuses redacted original fixtures",
    async (source) => {
      const f = fixture({ source });
      await expect(
        publishReviewFix(f.client, binding, {
          ...proposal,
          files: [
            {
              path: "src/file.ts",
              content:
                "const fixture = '[REDACTED_PRIVATE_KEY]';\nconst value = 2;\n",
            },
          ],
        }),
      ).rejects.toThrow("redact");
      expect(f.blobs).toHaveLength(0);
      expect(f.updates).toHaveLength(0);
      expect(f.mutations).toHaveLength(0);
      expect(f.refs).toHaveLength(0);
    },
  );
  test("prefix safety skips only explicit missing source paths", async () => {
    const f = fixture({ missingPaths: ["deleted.ts"] });
    const result = await fetchFixSources(f.client, {
      ...binding,
      allowedPaths: ["deleted.ts", "src/file.ts"],
    });
    expect(result).toEqual({
      sources: [{ path: "src/file.ts", content: "old\n" }],
      skippedPaths: ["deleted.ts"],
    });
    const published = await publishReviewFix(f.client, binding, proposal);
    expect(published.body).toContain(fixed);
  });
  test.each([403, 500])(
    "prefix safety never skips source failure %i",
    async (sourceStatus) => {
      const f = fixture({ sourceStatus });
      await expect(fetchFixSources(f.client, binding)).rejects.toThrow(
        "Source unavailable",
      );
    },
  );
  test("prefix safety never skips source transport failure", async () => {
    const f = fixture({ sourceTransport: true });
    await expect(fetchFixSources(f.client, binding)).rejects.toThrow(
      "Transport unavailable",
    );
  });
  test("prefix safety keeps unsafe paths fatal even alongside a missing path", async () => {
    const f = fixture({ missingPaths: ["deleted.ts"] });
    await expect(
      fetchFixSources(f.client, {
        ...binding,
        allowedPaths: ["deleted.ts", ".github/workflows/ci.yml"],
      }),
    ).rejects.toThrow("unsafe");
    expect(f.updates).toHaveLength(0);
  });
  test.each(["rewind", "forward"] as const)(
    "prefix safety CAS refuses a concurrent %s without resurrecting history or opening another PR",
    async (race) => {
      const f = fixture({ race });
      await expect(
        publishReviewFix(f.client, binding, proposal),
      ).rejects.toThrow();
      expect(f.currentHead()).toBe(f.racedHead);
      expect(f.mutations).toHaveLength(1);
      expect(f.updates).toHaveLength(0);
      expect(f.refs).toHaveLength(0);
      expect(f.prs).toHaveLength(0);
    },
  );
  test("prefix safety unsupported CAS has no unsafe fallback", async () => {
    const f = fixture({ unsupportedCAS: true });
    await expect(publishReviewFix(f.client, binding, proposal)).rejects.toThrow(
      "Unknown mutation",
    );
    expect(f.currentHead()).toBe(head);
    expect(f.updates).toHaveLength(0);
    expect(f.refs).toHaveLength(0);
  });
  test("prefix safety missing repository node ID fails closed without any ref fallback", async () => {
    const f = fixture({ missingRepositoryId: true });
    await expect(publishReviewFix(f.client, binding, proposal)).rejects.toThrow(
      "unavailable",
    );
    expect(f.currentHead()).toBe(head);
    expect(f.mutations).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
    expect(f.refs).toHaveLength(0);
    expect(f.prs).toHaveLength(0);
  });
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
    expect(f.updates).toHaveLength(0);
    expect(f.mutations).toEqual([
      {
        input: {
          repositoryId: "repository-node",
          refUpdates: [
            {
              name: "refs/heads/feature",
              beforeOid: head,
              afterOid: fixed,
              force: false,
            },
          ],
        },
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
      expect(result.body).toContain("https://github.com/org/repo/pull/13");
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
    expect(f.mutations).toHaveLength(1);
    expect(f.updates).toHaveLength(0);
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
