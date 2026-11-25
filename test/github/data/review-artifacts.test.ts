import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  computeAndStoreDiff,
  fetchAndStoreComments,
  storeDescription,
  computeReviewArtifacts,
} from "../../../src/github/data/review-artifacts";
import * as childProcess from "child_process";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("review-artifacts", () => {
  let execSyncSpy: ReturnType<typeof spyOn>;
  let writeFileSpy: ReturnType<typeof spyOn>;
  let mkdirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    writeFileSpy = spyOn(fsPromises, "writeFile").mockResolvedValue();
    mkdirSpy = spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
  });

  afterEach(() => {
    execSyncSpy?.mockRestore();
    writeFileSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  describe("computeAndStoreDiff", () => {
    it("computes diff via git merge-base and writes to disk", async () => {
      execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
        cmd: string,
      ) => {
        if (cmd.includes("is-shallow-repository")) return "false\n";
        if (cmd.includes("fetch origin main")) return "";
        if (cmd.includes("merge-base")) return "abc123\n";
        if (cmd.includes("diff")) return "diff --git a/f.ts b/f.ts\n+line\n";
        return "";
      }) as typeof childProcess.execSync);

      const result = await computeAndStoreDiff("main", "/tmp/test");

      expect(result).toBe("/tmp/test/droid-prompts/pr.diff");
      expect(mkdirSpy).toHaveBeenCalledWith("/tmp/test/droid-prompts", {
        recursive: true,
      });
      const writeCall = writeFileSpy.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" && (c[0] as string).includes("pr.diff"),
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![1]).toContain("diff --git");
    });

    it("falls back to gh pr diff when merge-base fails", async () => {
      execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
        cmd: string,
        opts?: any,
      ) => {
        if (cmd.includes("is-shallow-repository")) return "false\n";
        if (cmd.includes("merge-base")) throw new Error("no merge base");
        if (cmd.includes("gh pr diff")) {
          expect(opts?.env?.GH_TOKEN).toBe("test-token");
          return "diff from gh cli\n";
        }
        return "";
      }) as typeof childProcess.execSync);

      const result = await computeAndStoreDiff("main", "/tmp/test", {
        githubToken: "test-token",
        prNumber: 42,
      });

      expect(result).toBe("/tmp/test/droid-prompts/pr.diff");
      const writeCall = writeFileSpy.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" && (c[0] as string).includes("pr.diff"),
      );
      expect(writeCall![1]).toContain("diff from gh cli");
    });

    // actions/checkout may not have persisted a credential, so with a token
    // the fetches authenticate through gh instead.
    it("authenticates its fetches through gh when given a token", async () => {
      const fetches: { cmd: string; token?: string }[] = [];
      execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
        cmd: string,
        opts?: any,
      ) => {
        if (cmd.includes("is-shallow-repository")) return "true\n";
        if (cmd.includes(" fetch ")) {
          fetches.push({ cmd, token: opts?.env?.GH_TOKEN });
          return "";
        }
        if (cmd.includes("merge-base")) return "abc123\n";
        if (cmd.includes("diff")) return "diff --git a/f.ts b/f.ts\n";
        return "";
      }) as typeof childProcess.execSync);

      await computeAndStoreDiff("main", "/tmp/test", {
        githubToken: "test-token",
        prNumber: 42,
      });

      expect(fetches).toHaveLength(2);
      for (const fetch of fetches) {
        expect(fetch.cmd).toContain(
          "credential.helper=!gh auth git-credential",
        );
        expect(fetch.token).toBe("test-token");
      }
    });

    it("throws when merge-base fails and no fallback credentials", async () => {
      execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
        cmd: string,
      ) => {
        if (cmd.includes("is-shallow-repository")) return "false\n";
        if (cmd.includes("merge-base")) throw new Error("no merge base");
        return "";
      }) as typeof childProcess.execSync);

      await expect(computeAndStoreDiff("main", "/tmp/test")).rejects.toThrow(
        "no fallback credentials",
      );
    });
  });

  describe("storeDescription", () => {
    it("writes PR title and body as markdown", async () => {
      const result = await storeDescription(
        "My Feature",
        "Adds cool stuff",
        "/tmp/test",
      );

      expect(result).toBe("/tmp/test/droid-prompts/pr_description.txt");
      const writeCall = writeFileSpy.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("pr_description.txt"),
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![1]).toBe("# My Feature\n\nAdds cool stuff");
    });

    it("handles empty body", async () => {
      await storeDescription("Title Only", "", "/tmp/test");

      const writeCall = writeFileSpy.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("pr_description.txt"),
      );
      expect(writeCall![1]).toBe("# Title Only\n\n");
    });
  });

  describe("computeReviewArtifacts", () => {
    it("runs all three artifact computations in parallel", async () => {
      execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
        cmd: string,
      ) => {
        if (cmd.includes("is-shallow-repository")) return "false\n";
        if (cmd.includes("merge-base")) return "abc123\n";
        if (cmd.includes("diff")) return "some diff\n";
        return "";
      }) as typeof childProcess.execSync);

      const mockOctokit = {
        rest: {
          issues: {
            listComments: () => Promise.resolve({ data: [] }),
          },
          pulls: {
            listReviewComments: () => Promise.resolve({ data: [] }),
          },
        },
      } as any;

      const result = await computeReviewArtifacts({
        baseRef: "main",
        tempDir: "/tmp/test",
        octokit: mockOctokit,
        owner: "owner",
        repo: "repo",
        prNumber: 99,
        title: "Test PR",
        body: "Test body",
        githubToken: "token",
      });

      expect(result.diffPath).toContain("pr.diff");
      expect(result.commentsPath).toContain("existing_comments.json");
      expect(result.descriptionPath).toContain("pr_description.txt");
    });
  });
});

function mockCommentPages(
  issuePages: readonly (readonly unknown[])[],
  reviewPages: readonly (readonly unknown[])[],
): Parameters<typeof fetchAndStoreComments>[0] {
  const listComments =
    (pages: readonly (readonly unknown[])[]) =>
    async ({ page = 1 }: { page?: number }) => {
      const data = pages[page - 1];
      if (!data) throw new Error(`Unexpected comment page: ${page}`);
      return { data };
    };
  return {
    rest: {
      issues: { listComments: listComments(issuePages) },
      pulls: { listReviewComments: listComments(reviewPages) },
    },
  } as unknown as Parameters<typeof fetchAndStoreComments>[0];
}

describe("fetchAndStoreComments", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(join(tmpdir(), "droid-review-comments-"));
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it("writes only the exact metadata reduction and leaves API data unchanged", async () => {
    const retainedAuthor = {
      login: "reviewer",
      id: 11,
      node_id: "author-node",
      type: "User",
      site_admin: false,
      future_profile: { url: "https://example.invalid/profile-extra" },
    };
    const actorDecoration = {
      url: "https://example.invalid/users/reviewer",
      html_url: "https://example.invalid/reviewer",
      avatar_url: "https://example.invalid/avatar",
      gravatar_id: "gravatar-id",
      followers_url: "https://example.invalid/followers",
      following_url: "https://example.invalid/following{/other_user}",
      gists_url: "https://example.invalid/gists{/gist_id}",
      starred_url: "https://example.invalid/starred{/owner}{/repo}",
      subscriptions_url: "https://example.invalid/subscriptions",
      organizations_url: "https://example.invalid/orgs",
      repos_url: "https://example.invalid/repos",
      events_url: "https://example.invalid/events{/privacy}",
      received_events_url: "https://example.invalid/received_events",
    };
    const retainedOwner = { login: "app-owner", id: 12, type: "Organization" };
    const retainedApp = {
      id: 13,
      slug: "review-app",
      html_url: "https://example.invalid/apps/review-app",
      url: "https://example.invalid/api/apps/review-app",
      owner: retainedOwner,
    };
    const retainedReactions = {
      total_count: 2,
      "+1": 1,
      heart: 1,
      html_url: "https://example.invalid/unknown-reaction-field",
    };
    const retainedIssue = {
      id: 10,
      body: "See https://example.invalid/evidence\n<!-- review-state: open -->",
      url: "https://example.invalid/api/issues/comments/10",
      html_url: "https://example.invalid/pull/42#issuecomment-10",
      author_association: "MEMBER",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T01:00:00Z",
      user: retainedAuthor,
      performed_via_github_app: retainedApp,
      reactions: retainedReactions,
      future_metadata: {
        user: { avatar_url: "https://example.invalid/keep" },
        reactions: { url: "https://example.invalid/keep-reaction-link" },
      },
    };
    const issue = {
      ...retainedIssue,
      user: { ...retainedAuthor, ...actorDecoration },
      performed_via_github_app: {
        ...retainedApp,
        owner: { ...retainedOwner, ...actorDecoration },
      },
      reactions: {
        ...retainedReactions,
        url: "https://example.invalid/reactions",
      },
    };
    const retainedReview = {
      id: 20,
      body: "Inline review finding",
      url: "https://example.invalid/api/pulls/comments/20",
      html_url: "https://example.invalid/pull/42#discussion_r20",
      user: retainedAuthor,
      author_association: "COLLABORATOR",
      pull_request_review_id: 5,
      performed_via_github_app: retainedApp,
      path: "src/example.ts",
      diff_hunk: "@@ -1 +1 @@\n-old\n+new",
      line: null,
      start_line: null,
      original_line: 7,
      original_start_line: 6,
      side: "RIGHT",
      start_side: "RIGHT",
      commit_id: "current-commit",
      original_commit_id: "previous-commit",
      _links: { self: { href: "https://example.invalid/api/pulls/comments/20" } },
      reactions: { total_count: 1, eyes: 1 },
    };
    const review = {
      ...retainedReview,
      user: issue.user,
      performed_via_github_app: issue.performed_via_github_app,
      reactions: {
        ...retainedReview.reactions,
        url: "https://example.invalid/review-reactions",
      },
    };
    const reply = { id: 21, in_reply_to_id: 20, body: "Fixed in the next commit" };
    const raw = { issueComments: [issue], reviewComments: [review, reply] };
    const before = JSON.stringify(raw);
    const expected = JSON.stringify(
      { issueComments: [retainedIssue], reviewComments: [retainedReview, reply] },
      null,
      2,
    );

    const path = await fetchAndStoreComments(
      mockCommentPages([raw.issueComments], [raw.reviewComments]),
      "owner",
      "repo",
      42,
      tempDir,
    );

    expect(path).toBe(join(tempDir, "droid-prompts", "existing_comments.json"));
    expect(await fsPromises.readFile(path, "utf8")).toBe(expected);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("preserves empty or absent objects and comment order across pages", async () => {
    const retainedActors = {
      user: { login: "first-page-author" },
      performed_via_github_app: { id: 9, owner: { login: "page-app-owner" } },
    };
    const decoratedActors = {
      user: {
        ...retainedActors.user,
        url: "https://example.invalid/first-page-author",
      },
      performed_via_github_app: {
        ...retainedActors.performed_via_github_app,
        owner: {
          ...retainedActors.performed_via_github_app.owner,
          avatar_url: "https://example.invalid/first-page-app-owner",
        },
      },
    };
    const issueTail = Array.from({ length: 99 }, (_, i) => ({ id: 98 - i }));
    const reviewTail = Array.from({ length: 99 }, (_, i) => ({ id: 198 - i }));
    const firstIssuePage = Object.freeze([
      { id: 99, ...decoratedActors },
      ...issueTail,
    ]);
    const firstReviewPage = Object.freeze([
      { id: 199, ...decoratedActors },
      ...reviewTail,
    ]);
    const before = JSON.stringify([firstIssuePage, firstReviewPage]);
    const untouched = [
      { id: 200, user: null, performed_via_github_app: null, reactions: null },
      { id: 201, performed_via_github_app: { id: 7, owner: null } },
      { id: 202, performed_via_github_app: { id: 8 } },
      { id: 203, user: {}, performed_via_github_app: { owner: {} } },
      {
        id: 204,
        user: [{ url: "https://example.invalid/untouched" }],
        performed_via_github_app: { owner: "unchanged" },
        reactions: [],
      },
    ];
    const retainedLast = { id: 205, user: { login: "later-author" } };
    const last = {
      ...retainedLast,
      user: { ...retainedLast.user, url: "https://example.invalid/author" },
    };

    const path = await fetchAndStoreComments(
      mockCommentPages(
        [firstIssuePage, [...untouched, last]],
        [firstReviewPage, [last]],
      ),
      "owner",
      "repo",
      42,
      tempDir,
    );

    expect(await fsPromises.readFile(path, "utf8")).toBe(
      JSON.stringify(
        {
          issueComments: [
            { id: 99, ...retainedActors },
            ...issueTail,
            ...untouched,
            retainedLast,
          ],
          reviewComments: [
            { id: 199, ...retainedActors },
            ...reviewTail,
            retainedLast,
          ],
        },
        null,
        2,
      ),
    );
    expect(JSON.stringify([firstIssuePage, firstReviewPage])).toBe(before);
  });
});
