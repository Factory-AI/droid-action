import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createMockContext } from "../../mockContext";
import { resolveReviewUxConfig } from "../../../src/core/review/config";
import { loadReviewUxConfigFromBase } from "../../../src/github/data/review-config";
import {
  encodeFindingMarker,
  encodeReviewState,
  decodeReviewState,
  decodeSeverityMarker,
  SUMMARY_MARKER,
  type ReviewState,
} from "../../../src/core/review/markers";
import { normalizeFinding } from "../../../src/core/review/validated/finding";
import {
  renderCheckRun,
  renderInlineComment,
  renderReviewBody,
  renderReviewSummary,
  renderSecurityReport,
  renderStepSummary,
  validateRenderedMarkdown,
} from "../../../src/core/review/render";
import { run as postReview } from "../../../src/entrypoints/github-post-review";
import { postCommand } from "../../../src/entrypoints/github-post-command";
import { run as runLifecycle } from "../../../src/entrypoints/github-review-lifecycle";
import { freezeReviewCli } from "../../../src/entrypoints/freeze-review-cli";
import { freezeReviewRuntime } from "../../../src/prepare/review-runtime";
import { withRequestRedaction } from "../../../src/github/api/client";
import {
  findReviewSummary,
  finishReviewLifecycle,
  loadBoundReviewLifecycle,
  prepareReviewLifecycle,
  listDroidThreads,
  saveReviewLifecycle,
  type ReviewLifecycleRun,
} from "../../../src/github/operations/review-lifecycle";
import {
  publishReviewFix,
  type FixBinding,
} from "../../../src/github/operations/review-fix";

const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);
const FIXED = "3".repeat(40);
const BOT = "acceptance-droid[bot]";
const DIFF =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2 +2 @@\n-before\n+after\n";
type ApiCall = { method: string; url: URL; body: Record<string, unknown> };
type ApiRoute = (call: ApiCall) => Response;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** Real clients and serialization, but no request can leave this fixture. */
function boundary(route: ApiRoute) {
  const calls: ApiCall[] = [];
  const fetch = Object.assign(
    async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: RequestInit,
    ) => {
      const call: ApiCall = {
        url: new URL(input instanceof Request ? input.url : String(input)),
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string" ? object(JSON.parse(init.body)) : {},
      };
      calls.push(call);
      return route(call);
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  return {
    calls,
    octokit: {
      rest: withRequestRedaction(
        new Octokit({
          auth: "fixture-credential",
          baseUrl: "https://api.acceptance.invalid",
          request: { fetch },
          log: { debug() {}, info() {}, warn() {}, error() {} },
        }),
        "fixture-credential",
      ),
      graphql: graphql.defaults({
        baseUrl: "https://api.acceptance.invalid",
        request: { fetch },
      }),
    },
  };
}

function unexpected(call: ApiCall): never {
  throw new Error(
    `Unexpected fixture request: ${call.method} ${call.url.pathname}`,
  );
}
function writes(calls: ApiCall[]) {
  return calls.filter((call) => !["GET", "HEAD"].includes(call.method));
}
function thread(resolved = false, author = BOT) {
  return {
    id: "thread-known",
    isResolved: resolved,
    path: "src/a.ts",
    line: 2,
    comments: {
      nodes: [
        {
          databaseId: 19,
          body: encodeFindingMarker({ id: "known", sev: "P2" }),
          url: "https://github.example/base/repo/pull/7#discussion_r19",
          author: { login: author, databaseId: author === BOT ? 99 : 88 },
        },
      ],
    },
  };
}
function reviewBoundary(
  options: {
    resolved?: boolean;
    forbidden?: boolean;
    previous?: ReviewState;
    description?: string;
  } = {},
) {
  return boundary((call) => {
    if (call.url.pathname === "/graphql") {
      if (String(call.body.query).includes("DroidViewer"))
        return Response.json({ data: { viewer: { login: BOT } } });
      if (String(call.body.query).includes("DroidReviewThreads"))
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [thread(options.resolved)],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      if (String(call.body.query).includes("DroidResolveThread"))
        return Response.json({
          data: {
            resolveReviewThread: {
              thread: { id: "thread-known", isResolved: true },
            },
          },
        });
      return unexpected(call);
    }
    if (call.method === "GET" && call.url.pathname.endsWith("/pulls/7/reviews"))
      return Response.json([]);
    if (
      call.method === "GET" &&
      call.url.pathname.endsWith("/issues/7/comments")
    )
      return Response.json(
        options.previous
          ? [
              {
                id: 17,
                user: { id: 99, login: BOT },
                body: `${SUMMARY_MARKER}\n${encodeReviewState(options.previous)}`,
              },
            ]
          : [],
      );
    if (
      call.method === "GET" &&
      call.url.pathname.endsWith("/issues/comments/17")
    )
      return Response.json({
        id: 17,
        user: { id: 99, login: BOT },
        issue_url: "https://api.acceptance.invalid/repos/base/repo/issues/7",
        body: `${SUMMARY_MARKER}\n${encodeReviewState(options.previous ?? { head: BASE, findings: [] })}\n<!-- droid-review-active:v1 head=${HEAD} run=fixture-run -->`,
      });
    if (call.method === "GET" && call.url.pathname.endsWith("/check-runs/11"))
      return Response.json({ id: 11, name: "Droid Review", head_sha: HEAD });
    if (call.method === "GET" && call.url.pathname.endsWith("/pulls/7"))
      return Response.json({
        head: { sha: HEAD },
        base: { sha: BASE },
        title: "Fixture PR",
        body: options.description ?? "Author text.",
      });
    if (call.method === "GET" && call.url.pathname.includes("/compare/"))
      return new Response(DIFF, { headers: { "content-type": "text/plain" } });
    if (options.forbidden && call.method !== "GET")
      return Response.json(
        { message: `forbidden fk-${"x".repeat(25)}` },
        { status: 403 },
      );
    if (
      call.method === "POST" &&
      call.url.pathname.endsWith("/pulls/7/reviews")
    )
      return Response.json({ id: 23 });
    if (
      call.method === "GET" &&
      call.url.pathname.endsWith("/reviews/23/comments")
    )
      return Response.json([
        {
          id: 24,
          path: "src/a.ts",
          line: 2,
          body: encodeFindingMarker({ id: "new", sev: "P2" }),
          html_url: "https://github.example/base/repo/pull/7#discussion_r24",
        },
      ]);
    if (call.method === "PATCH" && call.url.pathname.endsWith("/pulls/7"))
      return Response.json({ number: 7 });
    if (
      call.method === "PATCH" &&
      call.url.pathname.endsWith("/issues/comments/17")
    )
      return Response.json({ id: 17 });
    if (call.method === "PATCH" && call.url.pathname.endsWith("/check-runs/11"))
      return Response.json({ id: 11 });
    if (call.method === "DELETE" && call.url.pathname.endsWith("/reactions/9"))
      return new Response(null, { status: 204 });
    if (call.method === "POST" && call.url.pathname.endsWith("/reactions"))
      return Response.json({ id: 10 });
    if (
      call.method === "POST" &&
      call.url.pathname.endsWith("/comments/19/replies")
    )
      return Response.json({ id: 20 });
    return unexpected(call);
  });
}

function lifecycle(): ReviewLifecycleRun {
  return {
    owner: "base",
    repo: "repo",
    prNumber: 7,
    commentId: 17,
    head: HEAD,
    base: BASE,
    state: { head: BASE, findings: [] },
    automatic: false,
    securityOnly: false,
    startedAt: new Date().toISOString(),
    checkId: 11,
    steps: [],
    reaction: { id: 9, targetId: 7, kind: "issue" },
  };
}
const finding = () =>
  normalizeFinding({
    id: "known",
    title: "Known issue",
    path: "src/a.ts",
    line: 2,
    severity: "P2",
    body: "Verified behavior.",
  });
const binding: FixBinding = {
  owner: "base",
  repo: "repo",
  prNumber: 7,
  actor: "maintainer",
  expectedHead: HEAD,
  mode: "commit",
  allowedPaths: ["src/a.ts"],
};
const proposal = {
  summary: "Fix the selected issue.",
  files: [{ path: "src/a.ts", content: "fixed\n" }],
};

function fixBoundary(
  options: {
    defaultBranch?: string;
    fork?: boolean;
    headMoves?: boolean;
    symlink?: boolean;
    protected?: boolean;
  } = {},
) {
  let prReads = 0;
  const destination = options.fork ? "fork-owner" : "base";
  return boundary((call) => {
    const p = decodeURIComponent(call.url.pathname);
    if (p.endsWith("/collaborators/maintainer/permission"))
      return Response.json({
        permission: p.includes("/fork-owner/") ? "read" : "write",
      });
    if (call.method === "GET" && p === "/repos/base/repo/pulls/7") {
      prReads++;
      return Response.json({
        state: "open",
        head: {
          sha: options.headMoves && prReads > 1 ? "4".repeat(40) : HEAD,
          ref: "feature",
          repo: {
            owner: { login: destination },
            name: "repo",
            full_name: `${destination}/repo`,
          },
        },
        base: { ref: "dev", sha: BASE },
      });
    }
    if (call.method === "GET" && p === `/repos/${destination}/repo`)
      return Response.json({
        permissions: { push: true },
        default_branch: options.defaultBranch ?? "main",
      });
    if (call.method === "GET" && p.endsWith("/branches/feature"))
      return Response.json({ protected: !!options.protected });
    if (call.method === "GET" && p.endsWith(`/git/commits/${HEAD}`))
      return Response.json({ tree: { sha: "old-tree" } });
    if (call.method === "GET" && p.endsWith("/git/trees/old-tree"))
      return Response.json({
        truncated: false,
        tree: [
          {
            path: "src/a.ts",
            sha: "old-blob",
            type: "blob",
            mode: options.symlink ? "120000" : "100755",
          },
        ],
      });
    if (call.method === "GET" && p.endsWith("/git/blobs/old-blob"))
      return Response.json({
        content: Buffer.from("before\n").toString("base64"),
        encoding: "base64",
      });
    if (call.method === "POST" && p.endsWith("/git/blobs"))
      return Response.json({ sha: "new-blob" });
    if (call.method === "POST" && p.endsWith("/git/trees"))
      return Response.json({ sha: "new-tree" });
    if (call.method === "POST" && p.endsWith("/git/commits"))
      return Response.json({ sha: FIXED });
    if (call.method === "PATCH" && p.endsWith("/git/refs/heads/feature"))
      return Response.json({ object: { sha: FIXED } });
    if (call.method === "POST" && p.endsWith("/git/refs"))
      return Response.json({ object: { sha: FIXED } });
    if (call.method === "GET" && p.endsWith("/pulls")) return Response.json([]);
    if (call.method === "POST" && p.endsWith("/pulls"))
      return Response.json({
        html_url: "https://github.example/base/repo/pull/8",
      });
    return unexpected(call);
  });
}

const envNames = [
  "RUNNER_TEMP",
  "REVIEW_LIFECYCLE_PATH",
  "REVIEW_VALIDATED_PATH",
  "REVIEW_DIFF_PATH",
  "REVIEW_POST_RESULTS_PATH",
  "GITHUB_STEP_SUMMARY",
  "DROID_BOT_LOGIN",
  "WORKFLOW_GITHUB_TOKEN",
  "FAIL_ON_SEVERITY",
  "SECURITY_BLOCK_ON_CRITICAL",
  "SECURITY_BLOCK_ON_HIGH",
  "REVIEW_AUTO_RESOLVE",
  "REPO_OWNER",
  "REPO_NAME",
  "PR_NUMBER",
  "REVIEW_HEAD_SHA",
  "REVIEW_BASE_SHA",
  "REVIEW_COMMENT_ID",
  "REVIEW_CHECK_ID",
  "REVIEW_STARTED_AT",
  "REVIEW_REACTION_ID",
  "REVIEW_REACTION_TARGET",
  "REVIEW_REACTION_KIND",
  "REVIEW_INCREMENTAL_BASE_SHA",
  "GITHUB_RUN_ID",
  "REVIEW_AUTOMATIC",
  "REVIEW_SECURITY_ONLY",
  "REVIEW_PHASE",
  "DROID_SUCCESS",
  "REVIEW_CONFIG_JSON",
  "REVIEW_REACTIONS",
  "REVIEW_CHECK_RUN",
  "REVIEW_INCREMENTAL",
  "REVIEW_MAX_AUTO_RUNS",
  "REVIEW_SUMMARY",
];
let directory: string;
let extraDirectories: string[];
let originalEnv: Map<string, string | undefined>;
let warningSpy: ReturnType<typeof spyOn>;
let outputSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  extraDirectories = [];
  originalEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  directory = await mkdtemp(path.join(tmpdir(), "droid-ux-acceptance-"));
  process.env.RUNNER_TEMP = directory;
  process.env.REVIEW_LIFECYCLE_PATH = path.join(directory, "lifecycle.json");
  process.env.REVIEW_VALIDATED_PATH = path.join(directory, "validated.json");
  process.env.REVIEW_DIFF_PATH = path.join(directory, "pr.diff");
  process.env.REVIEW_POST_RESULTS_PATH = path.join(directory, "posted.json");
  process.env.GITHUB_STEP_SUMMARY = path.join(directory, "summary.md");
  process.env.DROID_BOT_LOGIN = BOT;
  delete process.env.WORKFLOW_GITHUB_TOKEN;
  process.env.FAIL_ON_SEVERITY = "";
  process.env.SECURITY_BLOCK_ON_CRITICAL = "true";
  process.env.SECURITY_BLOCK_ON_HIGH = "false";
  process.env.REVIEW_AUTO_RESOLVE = "true";
  delete process.env.REVIEW_CONFIG_JSON;
  Object.assign(process.env, {
    REPO_OWNER: "base",
    REPO_NAME: "repo",
    PR_NUMBER: "7",
    REVIEW_HEAD_SHA: HEAD,
    REVIEW_BASE_SHA: BASE,
    REVIEW_COMMENT_ID: "17",
    REVIEW_CHECK_ID: "11",
    REVIEW_STARTED_AT: new Date().toISOString(),
    REVIEW_REACTION_ID: "9",
    REVIEW_REACTION_TARGET: "7",
    REVIEW_REACTION_KIND: "issue",
    REVIEW_INCREMENTAL_BASE_SHA: BASE,
    GITHUB_RUN_ID: "fixture-run",
    REVIEW_AUTOMATIC: "false",
    REVIEW_SECURITY_ONLY: "false",
    REVIEW_PHASE: "finalize",
    DROID_SUCCESS: "true",
  });
  warningSpy = spyOn(core, "warning").mockImplementation(() => {});
  outputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  warningSpy?.mockRestore();
  outputSpy?.mockRestore();
  logSpy?.mockRestore();
  errorSpy?.mockRestore();
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  for (const extra of extraDirectories)
    await rm(extra, { recursive: true, force: true });
});

describe("review UX production boundaries", () => {
  it("reads repository configuration only at the live immutable base SHA", async () => {
    const api = boundary((call) => {
      if (call.url.pathname.endsWith("/pulls/7"))
        return Response.json({ base: { sha: BASE }, head: { sha: HEAD } });
      if (call.url.pathname.endsWith(`/git/trees/${BASE}`))
        return Response.json({
          truncated: false,
          tree: [
            {
              path: ".factory",
              type: "tree",
              mode: "040000",
              sha: "d".repeat(40),
            },
          ],
        });
      if (call.url.pathname.endsWith(`/git/trees/${"d".repeat(40)}`))
        return Response.json({
          truncated: false,
          tree: [{ path: "review.yaml", type: "blob", mode: "100644" }],
        });
      if (
        decodeURIComponent(call.url.pathname).endsWith(
          "/contents/.factory/review.yaml",
        )
      )
        return Response.json({
          type: "file",
          encoding: "base64",
          content: Buffer.from(
            "review_reactions: true\nreview_max_auto_runs: 5\nfix_mode: off\n",
          ).toString("base64"),
        });
      return unexpected(call);
    });
    const config = await loadReviewUxConfigFromBase({
      client: api.octokit,
      owner: "base",
      repo: "repo",
      prNumber: 7,
      inputs: { review_reactions: "false", review_max_auto_runs: "0" },
    });
    expect(config).toMatchObject({
      review_reactions: false,
      review_max_auto_runs: 0,
      fix_mode: "off",
    });
    expect(api.calls[1]?.url.searchParams.get("ref")).toBe(BASE);
    expect(writes(api.calls)).toEqual([]);
  });

  it("ignores a human-planted summary marker across paginated API results", async () => {
    const api = boundary((call) => {
      if (call.url.pathname === "/graphql")
        return Response.json({ data: { viewer: { login: BOT } } });
      if (call.url.searchParams.get("page") === "1")
        return Response.json(
          Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            user: { id: 88, login: "human" },
            body: SUMMARY_MARKER,
          })),
        );
      return Response.json([
        { id: 101, user: { id: 99, login: BOT }, body: SUMMARY_MARKER },
      ]);
    });
    const summary = await findReviewSummary({
      octokit: api.octokit,
      owner: "base",
      repo: "repo",
      prNumber: 7,
    });
    expect(summary?.id).toBe(101);
    expect(
      api.calls.filter((call) => call.url.pathname.endsWith("/comments")),
    ).toHaveLength(2);
    expect(writes(api.calls)).toHaveLength(1); // GraphQL read only.
  });

  it("does not treat a human thread with a forged finding marker as a Droid thread", async () => {
    const api = boundary((call) =>
      Response.json({
        data: String(call.body.query).includes("DroidViewer")
          ? { viewer: { login: BOT } }
          : {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [thread(false, "human"), thread(true)],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
      }),
    );
    const threads = await listDroidThreads({
      octokit: api.octokit,
      owner: "base",
      repo: "repo",
      prNumber: 7,
    });
    expect(threads).toHaveLength(1);
    expect(threads[0]?.resolved).toBe(true);
  });

  it("warns once across forbidden metadata writes and still removes running eyes", async () => {
    const api = reviewBoundary({ forbidden: true });
    const run = lifecycle();
    await finishReviewLifecycle({
      octokit: api.octokit,
      run,
      input: { state: "clean", findings: [] },
    });
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(
      api.calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.url.pathname.endsWith("/reactions/9"),
      ),
    ).toBe(true);
    expect(
      api.calls.filter((call) => call.url.pathname.endsWith("/check-runs/11")),
    ).toHaveLength(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
      `fk-${"x".repeat(25)}`,
    );
    expect(run.completed).toBe(true);
  });

  for (const mode of [
    "absence",
    "escalation",
    "human-resolved",
    "fixed",
  ] as const) {
    it(`posts reconciled ${mode} through the real review entrypoint`, async () => {
      const run = lifecycle();
      const old = finding();
      if (mode !== "human-resolved")
        run.state.findings = [
          { id: old.id, sev: old.severity, state: "open", finding: old },
        ];
      const api = reviewBoundary({
        resolved: mode === "human-resolved",
        previous: run.state,
      });
      await saveReviewLifecycle(run);
      const current =
        mode === "escalation"
          ? {
              ...old,
              severity: "P0",
              security: true,
              securitySeverity: "critical",
              line: 12,
            }
          : old;
      const results =
        mode === "absence"
          ? []
          : mode === "fixed"
            ? [
                {
                  status: "fixed",
                  id: old.id,
                  evidence: "Verified replacement removes the issue.",
                },
              ]
            : [{ status: "approved", comment: current }];
      await writeFile(
        process.env.REVIEW_VALIDATED_PATH!,
        JSON.stringify({ meta: { headSha: HEAD }, results }),
      );
      await writeFile(
        process.env.REVIEW_DIFF_PATH!,
        "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2 +2 @@\n-before\n+after\n",
      );
      await postReview({
        octokit: api.octokit,
        context: createMockContext({
          isPR: true,
          entityNumber: 7,
          repository: { owner: "base", repo: "repo", full_name: "base/repo" },
        }),
      });
      expect(
        api.calls.some(
          (call) =>
            call.method === "POST" && call.url.pathname.endsWith("/reviews"),
        ),
      ).toBe(false);
      const completed = api.calls.find(
        (call) => call.body.status === "completed",
      );
      expect(completed?.body.conclusion).toBe(
        mode === "escalation"
          ? "failure"
          : mode === "absence"
            ? "neutral"
            : "success",
      );
      const resolved = api.calls.filter((call) =>
        String(call.body.query).includes("DroidResolveThread"),
      );
      expect(resolved).toHaveLength(mode === "fixed" ? 1 : 0);
      const stored: ReviewLifecycleRun = JSON.parse(
        await readFile(process.env.REVIEW_LIFECYCLE_PATH!, "utf8"),
      );
      expect(stored.state.findings[0]?.state).toBe(
        mode === "human-resolved"
          ? "dismissed"
          : mode === "fixed"
            ? "resolved"
            : "open",
      );
      if (mode === "escalation") {
        expect(stored.state.findings[0]?.finding?.line).toBe(12);
        expect(stored.state.findings[0]?.sev).toBe("P0");
      }
      const reactions = api.calls.filter((call) =>
        call.url.pathname.endsWith("/reactions"),
      );
      expect(
        reactions.every((call) =>
          ["hooray", "confused"].includes(String(call.body.content)),
        ),
      ).toBe(true);
    });
  }

  for (const target of ["repository", "pr", "head"] as const) {
    it(`rejects model-tampered lifecycle ${target} before any API write`, async () => {
      const api = reviewBoundary();
      const cached = lifecycle();
      if (target === "repository") cached.owner = "attacker";
      else if (target === "pr") cached.prNumber = 99;
      else cached.head = "f".repeat(40);
      await saveReviewLifecycle(cached);
      await expect(runLifecycle({ octokit: api.octokit })).rejects.toThrow(
        "immutable",
      );
      expect(api.calls).toEqual([]);
    });
  }

  it("rehydrates lifecycle IDs and finding dispositions from immutable outputs and live owned state", async () => {
    const old = finding();
    const live: ReviewState = {
      head: BASE,
      findings: [
        { id: old.id, sev: old.severity, state: "open", finding: old },
      ],
    };
    const api = reviewBoundary({ previous: live });
    await saveReviewLifecycle({
      ...lifecycle(),
      commentId: 999,
      checkId: 999,
      reaction: { id: 999, targetId: 999, kind: "review_comment" },
      state: {
        head: HEAD,
        findings: [{ id: old.id, sev: "P2", state: "resolved", finding: old }],
      },
    });
    const bound = await loadBoundReviewLifecycle(api.octokit);
    expect(bound).toMatchObject({
      commentId: 17,
      checkId: 11,
      reaction: { id: 9, targetId: 7, kind: "issue" },
      state: { head: BASE, findings: [{ id: old.id, state: "open" }] },
    });
    expect(api.calls.some((call) => call.url.pathname.includes("999"))).toBe(
      false,
    );
  });

  it("cannot finalize a clean review from model-forged cached renderer input or fixed eligibility", async () => {
    const old = finding();
    const live: ReviewState = {
      head: BASE,
      findings: [
        { id: old.id, sev: old.severity, state: "open", finding: old },
      ],
    };
    const api = reviewBoundary({ previous: live });
    await saveReviewLifecycle({
      ...lifecycle(),
      state: live,
      renderInput: { state: "clean", findings: [] },
      eligibleFixedIds: ["known"],
    });
    const bound = await loadBoundReviewLifecycle(api.octokit);
    expect(bound?.renderInput).toBeUndefined();
    expect(bound?.eligibleFixedIds).toBeUndefined();
    await runLifecycle({ octokit: api.octokit });
    const completed = api.calls.find(
      (call) => call.body.status === "completed",
    );
    expect(completed?.body.conclusion).toBe("neutral");
    expect(api.calls.some((call) => call.body.content === "hooray")).toBe(
      false,
    );
    expect(api.calls.some((call) => call.body.content === "confused")).toBe(
      true,
    );
  });

  it("degrades all forbidden review writes to one warning with an offline step summary", async () => {
    const api = reviewBoundary({ forbidden: true });
    const run = lifecycle();
    await saveReviewLifecycle(run);
    await writeFile(
      process.env.REVIEW_VALIDATED_PATH!,
      JSON.stringify({
        meta: { headSha: HEAD },
        results: [{ status: "approved", comment: { ...finding(), id: "new" } }],
      }),
    );
    await writeFile(process.env.REVIEW_DIFF_PATH!, DIFF);
    await expect(
      postReview({
        octokit: api.octokit,
        context: createMockContext({
          isPR: true,
          entityNumber: 7,
          repository: { owner: "base", repo: "repo", full_name: "base/repo" },
        }),
      }),
    ).resolves.toMatchObject({ failed: 0 });
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(await readFile(process.env.GITHUB_STEP_SUMMARY!, "utf8")).toContain(
      "Known issue",
    );
  });

  it("honors canonical off/false/zero settings in real preparation and finalization without hidden-comment spam", async () => {
    process.env.REVIEW_CONFIG_JSON = JSON.stringify(
      resolveReviewUxConfig({
        inputs: {
          review_summary: "off",
          review_reactions: "false",
          review_check_run: "false",
          review_incremental: "false",
          review_max_auto_runs: "0",
        },
      }),
    );
    process.env.REVIEW_REACTIONS = "true";
    process.env.REVIEW_CHECK_RUN = "true";
    process.env.REVIEW_INCREMENTAL = "true";
    process.env.REVIEW_MAX_AUTO_RUNS = "1";
    const api = reviewBoundary({
      previous: { head: HEAD, autoRunCount: 999, findings: [] },
    });
    const prepared = await prepareReviewLifecycle({
      octokit: api.octokit,
      headSha: HEAD,
      baseSha: BASE,
      context: createMockContext({
        isPR: true,
        eventName: "pull_request",
        entityNumber: 7,
        repository: { owner: "base", repo: "repo", full_name: "base/repo" },
      }),
    });
    expect(prepared.skipReason).toBeUndefined();
    expect(prepared.incrementalBaseSha).toBeUndefined();
    await finishReviewLifecycle({
      octokit: api.octokit,
      run: prepared.run,
      input: { state: "clean", findings: [] },
    });
    expect(
      writes(api.calls).filter((call) => call.url.pathname !== "/graphql"),
    ).toEqual([]);
    expect(await readFile(process.env.GITHUB_STEP_SUMMARY!, "utf8")).toContain(
      "No issues found",
    );
  });

  it("preserves author text around only the owned description block and keeps state in its marker comment", async () => {
    process.env.REVIEW_CONFIG_JSON = JSON.stringify(
      resolveReviewUxConfig({ inputs: { review_summary: "description" } }),
    );
    const before =
      "Author introduction.\n\n~~~markdown\n<!-- droid-review-summary:start -->\nexample markers remain\n<!-- droid-review-summary:end -->\n~~~\n\n";
    const after = "\n\nAuthor closing notes.";
    const description = `${before}<!-- droid-review-summary:start -->\nold generated content\n<!-- droid-review-summary:end -->${after}`;
    const api = reviewBoundary({ description });
    await finishReviewLifecycle({
      octokit: api.octokit,
      run: lifecycle(),
      input: { state: "clean", findings: [] },
    });
    const updated = api.calls.find(
      (call) =>
        call.method === "PATCH" && call.url.pathname.endsWith("/pulls/7"),
    );
    const body = String(updated?.body.body);
    expect(body.startsWith(before)).toBe(true);
    expect(body.endsWith(after)).toBe(true);
    expect(body).not.toContain("old generated content");
    expect(body).toContain('id="droid-review-summary"');
    expect(body).toContain("No issues found");
    const stateComment = api.calls.find(
      (call) =>
        call.method === "PATCH" &&
        call.url.pathname.endsWith("/issues/comments/17"),
    );
    expect(String(stateComment?.body.body)).toContain(SUMMARY_MARKER);
    expect(String(stateComment?.body.body)).not.toContain("###");
  });

  it("links the actual posted review to the description summary rather than its hidden state comment", async () => {
    process.env.REVIEW_CONFIG_JSON = JSON.stringify(
      resolveReviewUxConfig({ inputs: { review_summary: "description" } }),
    );
    const api = reviewBoundary();
    await saveReviewLifecycle(lifecycle());
    await writeFile(
      process.env.REVIEW_VALIDATED_PATH!,
      JSON.stringify({
        meta: { headSha: HEAD },
        results: [{ status: "approved", comment: { ...finding(), id: "new" } }],
      }),
    );
    await writeFile(process.env.REVIEW_DIFF_PATH!, DIFF);
    await postReview({
      octokit: api.octokit,
      context: createMockContext({
        isPR: true,
        entityNumber: 7,
        repository: { owner: "base", repo: "repo", full_name: "base/repo" },
      }),
    });
    const review = api.calls.find(
      (call) =>
        call.method === "POST" && call.url.pathname.endsWith("/reviews"),
    );
    expect(String(review?.body.body)).toContain("/pull/7#droid-review-summary");
    expect(String(review?.body.body)).not.toContain("#issuecomment-17");
    expect(review?.body.event).toBe("COMMENT");
  });

  it("keeps canonical auto-resolve false despite poisoned environment flags while detecting fixed state", async () => {
    process.env.REVIEW_CONFIG_JSON = JSON.stringify(
      resolveReviewUxConfig({ inputs: { review_auto_resolve: "false" } }),
    );
    process.env.REVIEW_AUTO_RESOLVE = "true";
    const old = finding();
    const live: ReviewState = {
      head: BASE,
      findings: [{ id: old.id, sev: "P2", state: "open", finding: old }],
    };
    const api = reviewBoundary({ previous: live });
    await saveReviewLifecycle({ ...lifecycle(), state: live });
    await writeFile(
      process.env.REVIEW_VALIDATED_PATH!,
      JSON.stringify({
        meta: { headSha: HEAD },
        results: [
          {
            status: "fixed",
            id: old.id,
            evidence: "Verified fix in changed lines.",
          },
        ],
      }),
    );
    await writeFile(process.env.REVIEW_DIFF_PATH!, DIFF);
    await postReview({
      octokit: api.octokit,
      context: createMockContext({
        isPR: true,
        entityNumber: 7,
        repository: { owner: "base", repo: "repo", full_name: "base/repo" },
      }),
    });
    expect(
      api.calls.some((call) =>
        String(call.body.query).includes("DroidResolveThread"),
      ),
    ).toBe(false);
    expect(
      api.calls.some(
        (call) =>
          call.method === "POST" &&
          call.url.pathname.endsWith("/comments/19/replies"),
      ),
    ).toBe(false);
    const stored: ReviewLifecycleRun = JSON.parse(
      await readFile(process.env.REVIEW_LIFECYCLE_PATH!, "utf8"),
    );
    expect(stored.state.findings[0]?.state).toBe("resolved");
  });

  it("applies canonical blocking thresholds rather than model-overridden environment flags", async () => {
    process.env.REVIEW_CONFIG_JSON = JSON.stringify(
      resolveReviewUxConfig({
        inputs: { fail_on_severity: "P1", security_block_on_critical: "false" },
      }),
    );
    process.env.FAIL_ON_SEVERITY = "";
    process.env.SECURITY_BLOCK_ON_CRITICAL = "true";
    const api = reviewBoundary();
    await finishReviewLifecycle({
      octokit: api.octokit,
      run: lifecycle(),
      input: {
        state: "findings",
        findings: [{ ...finding(), severity: "P1" }],
      },
    });
    expect(
      api.calls.find((call) => call.body.status === "completed")?.body
        .conclusion,
    ).toBe("failure");
  });

  it("guards the actual publisher shell against startup environment, runtime, and bundle tampering", async () => {
    const source = await readFile(
      new URL("../../../action.yml", import.meta.url),
      "utf8",
    );
    const step =
      source
        .split("    - name: Publish Droid command result\n")[1]
        ?.split("\n    - name:")[0] ?? "";
    expect(step).toContain(
      "shell: /bin/bash --noprofile --norc -p -eo pipefail {0}",
    );
    const script = step
      .split("      run: |\n")[1]
      ?.split("\n      env:")[0]
      ?.split("\n")
      .map((line) => line.slice(8))
      .join("\n");
    expect(script).toBeDefined();
    const cleared: Record<string, string> = {};
    for (const key of [
      "BASH_ENV",
      "ENV",
      "NODE_OPTIONS",
      "BUN_OPTIONS",
      "NODE_PATH",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "LD_AUDIT",
    ]) {
      expect(step).toContain(`        ${key}: ""`);
      cleared[key] = "";
    }
    const startup = path.join(directory, "startup.sh");
    const startupMarker = path.join(directory, "startup-ran");
    const publishedMarker = path.join(directory, "publisher-ran");
    const bundlePath = path.join(directory, "publisher.mjs");
    const shellPath = path.join(directory, "publisher-step.sh");
    await writeFile(
      startup,
      `printf unsafe > ${JSON.stringify(startupMarker)}\n`,
    );
    await writeFile(shellPath, script!);
    await writeFile(
      bundlePath,
      `await Bun.write(${JSON.stringify(publishedMarker)}, JSON.stringify(process.env));\n`,
    );
    const runtime = await Bun.file(process.execPath).arrayBuffer();
    const env = {
      PATH: "/untrusted/bin:/usr/bin:/bin",
      BASH_ENV: startup,
      HTTPS_PROXY: "https://untrusted.invalid",
      NODE_EXTRA_CA_CERTS: "/untrusted/certificate",
      NODE_DEBUG: "http",
      SSLKEYLOGFILE: path.join(directory, "untrusted-keylog"),
      COMMAND_PUBLISHER_PATH: bundlePath,
      COMMAND_PUBLISHER_SHA256: createHash("sha256")
        .update(await readFile(bundlePath))
        .digest("hex"),
      COMMAND_RUNTIME_PATH: process.execPath,
      COMMAND_RUNTIME_SHA256: createHash("sha256")
        .update(Buffer.from(runtime))
        .digest("hex"),
      COMMAND_MODE: "question",
      COMMAND_ACTOR: "maintainer",
      COMMAND_PR_NUMBER: "7",
      COMMAND_EXPECTED_HEAD: HEAD,
      COMMAND_FIX_MODE: "off",
      COMMAND_OUTPUT_PATH: path.join(directory, "answer.txt"),
      COMMAND_ROOT_COMMENT_ID: "19",
      REPO_OWNER: "base",
      REPO_NAME: "repo",
      GITHUB_TOKEN: "fixture-token",
      GITHUB_OUTPUT: path.join(directory, "outputs"),
      GITHUB_API_URL: "https://api.acceptance.invalid",
      GITHUB_SERVER_URL: "https://github.acceptance.invalid",
      DROID_SUCCESS: "true",
      ...cleared,
    };
    const execute = async () => {
      const child = Bun.spawn(
        [
          "/bin/bash",
          "--noprofile",
          "--norc",
          "-p",
          "-eo",
          "pipefail",
          shellPath,
        ],
        {
          env,
          cwd: directory,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };
    expect(await execute()).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await Bun.file(startupMarker).exists()).toBe(false);
    const publishedEnv = object(
      JSON.parse(await readFile(publishedMarker, "utf8")),
    );
    for (const key of [
      "HTTPS_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "NODE_DEBUG",
      "SSLKEYLOGFILE",
    ])
      expect(publishedEnv[key]).toBeUndefined();
    expect(publishedEnv.COMMAND_ACTOR).toBe("maintainer");
    const runtimeDigest = env.COMMAND_RUNTIME_SHA256;
    env.COMMAND_RUNTIME_SHA256 = "0".repeat(64);
    const rejectedRuntime = await execute();
    expect(rejectedRuntime.exitCode).not.toBe(0);
    expect(rejectedRuntime.stdout).toContain("changed during execution");
    env.COMMAND_RUNTIME_SHA256 = runtimeDigest;
    await writeFile(bundlePath, "throw new Error('tampered');\n");
    const rejected = await execute();
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stdout).toContain("changed during execution");
  });

  for (const wrapper of [
    {
      file: "../../../action.yml",
      preparation: "prepare",
      validator: "Run Droid Exec (validator)",
      steps: [
        ["Review lifecycle validated", "lifecycle"],
        ["Prepare validator", "validator"],
        ["Run Droid Exec (validator)", "runner"],
        ["Post review", "post"],
        ["Update comment with job link", "tracking"],
      ],
    },
    {
      file: "../../../review/action.yml",
      preparation: "prompt",
      validator: "Run Validator",
      steps: [
        ["Review lifecycle validated", "lifecycle"],
        ["Prepare Validator", "validator"],
        ["Run Validator", "runner"],
        ["Post Review", "post"],
        ["Update tracking comment", "tracking"],
      ],
    },
    {
      file: "../../../security/action.yml",
      preparation: "prompt",
      validator: "Run Validator",
      steps: [
        ["Review lifecycle validated", "lifecycle"],
        ["Prepare Validator", "validator"],
        ["Run Validator", "runner"],
        ["Post Review", "post"],
        ["Update tracking comment", "tracking"],
      ],
    },
  ]) {
    it(`executes actual ${wrapper.file} frozen guards and refuses publisher, runtime, and CLI tampering`, async () => {
      const source = await readFile(
        new URL(wrapper.file, import.meta.url),
        "utf8",
      );
      const bundlePath = path.join(directory, "frozen-publisher.mjs");
      const capturePath = path.join(directory, "publisher-env.json");
      const cliPath = path.join(directory, "frozen-droid");
      const bundle = `await Bun.write(${JSON.stringify(capturePath)}, JSON.stringify(process.env));\n`;
      await writeFile(bundlePath, bundle);
      await writeFile(cliPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const cli = await freezeReviewCli(cliPath);
      const runtimeDigest = createHash("sha256")
        .update(await readFile(process.execPath))
        .digest("hex");
      const config = JSON.stringify(
        resolveReviewUxConfig({
          inputs: { review_summary: "off", review_max_auto_runs: "0" },
        }),
      );
      const startupNames = [
        "BASH_ENV",
        "ENV",
        "NODE_OPTIONS",
        "BUN_OPTIONS",
        "NODE_PATH",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "LD_AUDIT",
      ];
      for (const [name, kind] of wrapper.steps) {
        const step = source
          .split(`    - name: ${name}\n`)[1]
          ?.split("\n    - name:")[0];
        expect(step).toBeDefined();
        expect(step).toContain(
          "shell: /bin/bash --noprofile --norc -p -eo pipefail {0}",
        );
        expect(step).toContain(
          `REVIEW_PUBLISHER_PATH: \${{ steps.${wrapper.preparation}.outputs.review_${kind}_publisher_path }}`,
        );
        expect(step).toContain(
          `REVIEW_PUBLISHER_SHA256: \${{ steps.${wrapper.preparation}.outputs.review_${kind}_publisher_sha256 }}`,
        );
        expect(step).toContain(
          `REVIEW_CONFIG_JSON: \${{ steps.${wrapper.preparation}.outputs.review_config_json }}`,
        );
        for (const key of startupNames) expect(step).toContain(`${key}: ""`);
        if (name === wrapper.validator) {
          expect(step).toContain(
            "INPUT_PATH_TO_DROID_EXECUTABLE: ${{ steps.review_cli.outputs.review_cli_path }}",
          );
          expect(step).toContain('FACTORY_DROID_AUTO_UPDATE_ENABLED: "false"');
        }
        const run = step?.split("      run: |\n")[1]?.split("\n      env:")[0];
        if (!run) throw new Error("Missing actual workflow script");
        const scriptPath = path.join(directory, `${kind}.sh`);
        await writeFile(
          scriptPath,
          run
            .split("\n")
            .map((line) => line.slice(8))
            .join("\n"),
        );
        const env: Record<string, string> = {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          REVIEW_PUBLISHER_PATH: bundlePath,
          REVIEW_PUBLISHER_SHA256: createHash("sha256")
            .update(bundle)
            .digest("hex"),
          REVIEW_RUNTIME_PATH: process.execPath,
          REVIEW_RUNTIME_SHA256: runtimeDigest,
          REVIEW_CLI_PATH: cli.review_cli_path,
          REVIEW_CLI_SHA256: cli.review_cli_sha256,
          REVIEW_CONFIG_JSON: config,
          REVIEW_HEAD_SHA: HEAD,
          REPO_OWNER: "base",
          REPO_NAME: "repo",
          PR_NUMBER: "7",
          GITHUB_TOKEN: "fixture-github-credential",
          WORKFLOW_GITHUB_TOKEN: "fixture-workflow-credential",
          FACTORY_API_KEY: "fixture-factory-key",
          HTTPS_PROXY: "https://poison.invalid",
          NODE_EXTRA_CA_CERTS: "/not-trusted",
          NODE_DEBUG: "*",
          SSLKEYLOGFILE: "/not-trusted",
          ...Object.fromEntries(startupNames.map((key) => [key, ""])),
        };
        const execute = async () => {
          const child = Bun.spawn(
            [
              "/bin/bash",
              "--noprofile",
              "--norc",
              "-p",
              "-eo",
              "pipefail",
              scriptPath,
            ],
            { cwd: directory, env, stdout: "pipe", stderr: "pipe" },
          );
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          return { exitCode, stdout, stderr };
        };
        expect(await execute()).toEqual({
          exitCode: 0,
          stdout: "",
          stderr: "",
        });
        const captured = object(
          JSON.parse(await readFile(capturePath, "utf8")),
        );
        expect(captured.REVIEW_CONFIG_JSON).toBe(config);
        for (const key of [
          "HTTPS_PROXY",
          "NODE_EXTRA_CA_CERTS",
          "NODE_DEBUG",
          "SSLKEYLOGFILE",
        ])
          expect(captured[key]).toBeUndefined();
        if (name === wrapper.validator) {
          expect(captured.GITHUB_TOKEN).toBeUndefined();
          expect(captured.WORKFLOW_GITHUB_TOKEN).toBeUndefined();
          await writeFile(cliPath, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
          const rejectedCli = await execute();
          expect(rejectedCli.exitCode).not.toBe(0);
          expect(rejectedCli.stdout).toContain("Droid executable changed");
          await writeFile(cliPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        }
        env.REVIEW_RUNTIME_SHA256 = "0".repeat(64);
        const rejectedRuntime = await execute();
        expect(rejectedRuntime.exitCode).not.toBe(0);
        expect(rejectedRuntime.stdout).toContain("changed during execution");
        env.REVIEW_RUNTIME_SHA256 = runtimeDigest;
        await writeFile(
          bundlePath,
          "throw new Error('untrusted modified publisher');\n",
        );
        const rejectedPublisher = await execute();
        expect(rejectedPublisher.exitCode).not.toBe(0);
        expect(rejectedPublisher.stdout).toContain("changed during execution");
        await writeFile(bundlePath, bundle);
      }
    }, 15000);
  }

  it("budgets oversized public output without losing counts, state identities, or structural validity", () => {
    const huge = "Unicode context 界 ".repeat(5000);
    const findings = Array.from({ length: 12 }, (_, index) =>
      normalizeFinding({
        id: `oversized-${index}`,
        title: `Verified issue ${index}`,
        path: `src/file${index}.ts`,
        line: index + 1,
        severity: `P${index % 3}`,
        security: index % 4 === 0,
        securitySeverity: index % 4 === 0 ? "critical" : undefined,
        body: index === 0 ? huge : huge.slice(0, 2000),
        why: index === 0 ? huge : huge.slice(0, 2000),
        verification: index === 0 ? huge : huge.slice(0, 2000),
        agent_prompt: index === 0 ? huge : huge.slice(0, 2000),
        outside_diff: true,
      }),
    );
    const reviewState: ReviewState = {
      head: HEAD,
      base: BASE,
      paused: false,
      autoRunCount: 2,
      findings: findings.map((finding, index) => ({
        id: finding.id,
        sev: finding.severity,
        state: "open",
        threadId: `thread-${index}`,
        commentId: 100 + index,
        url: `https://github.example/base/repo/pull/7#discussion_r${100 + index}`,
        finding,
      })),
    };
    const input = {
      state: "findings" as const,
      head: HEAD,
      base: BASE,
      findings,
      reviewState,
      repositoryUrl: "https://github.example/base/repo",
      candidatesConsidered: 15,
      postedCount: 12,
      dropped: [{ index: 12, path: "src/drop.ts", reason: huge }],
    };
    const summary = renderReviewSummary(input);
    const check = renderCheckRun({ ...input, phase: "completed" });
    for (const output of [
      summary,
      renderReviewBody(input),
      renderSecurityReport(input),
      renderStepSummary(input),
      check.summary,
      check.text,
    ]) {
      expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(60 * 1024);
      expect(validateRenderedMarkdown(output)).toEqual([]);
      expect(output).not.toContain("\uFFFD");
    }
    expect(summary).toContain(
      "**12 open findings** · `P0: 4` · `P1: 4` · `P2: 4` · `Security: 3`",
    );
    expect(decodeSeverityMarker(check.text)).toEqual({
      p0: 4,
      p1: 4,
      p2: 4,
      security: 3,
    });
    const restored = decodeReviewState(summary);
    expect(restored?.findings.map((item) => item.id)).toEqual(
      findings.map((item) => item.id),
    );
    expect(restored).toMatchObject({ paused: false, autoRunCount: 2 });
    expect(restored?.findings[0]).toMatchObject({
      threadId: "thread-0",
      commentId: 100,
      state: "open",
    });
    const inline = renderInlineComment({
      ...findings[0]!,
      outside_diff: false,
      suggestion: "complete replacement\n".repeat(5000),
    });
    expect(Buffer.byteLength(inline, "utf8")).toBeLessThanOrEqual(30 * 1024);
    expect(inline).toContain("No partial suggestion");
    expect(inline).not.toMatch(/^[`~]+suggestion/m);
    expect(validateRenderedMarkdown(inline)).toEqual([]);
  });

  it("runs the actual base-action command profile without inherited hooks, MCP, authority, or user tool arguments", async () => {
    const promptPath = path.join(directory, "command-prompt.txt");
    const capturePath = path.join(directory, "captured.json");
    const fakeDroid = path.join(directory, "fixture-droid");
    await writeFile(promptPath, "Answer using the supplied snapshot only.");
    await writeFile(
      fakeDroid,
      `#!${process.execPath}
await Bun.write(${JSON.stringify(capturePath)}, JSON.stringify({cwd:process.cwd(),env:process.env,args:process.argv.slice(2)}));
console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"done"}));
`,
      { mode: 0o700 },
    );
    const frozen = await freezeReviewRuntime();
    const runnerPath = frozen.review_runner_publisher_path;
    if (!runnerPath) throw new Error("Missing frozen runner");
    extraDirectories.push(path.dirname(runnerPath));
    for (const kind of [
      "lifecycle",
      "post",
      "tracking",
      "validator",
      "runner",
    ]) {
      const publisherPath = frozen[`review_${kind}_publisher_path`];
      const publisherDigest = frozen[`review_${kind}_publisher_sha256`];
      if (!publisherPath || !publisherDigest)
        throw new Error(`Missing frozen ${kind} publisher`);
      expect(
        createHash("sha256")
          .update(await readFile(publisherPath))
          .digest("hex"),
      ).toBe(publisherDigest);
    }
    const child = Bun.spawn(
      [
        process.execPath,
        "--config=/dev/null",
        "--env-file=/dev/null",
        runnerPath,
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          FACTORY_API_KEY: "fixture-factory-key",
          DROID_COMMAND_MODE: "fix",
          INPUT_PROMPT_FILE: promptPath,
          INPUT_PATH_TO_DROID_EXECUTABLE: fakeDroid,
          INPUT_DROID_ARGS:
            '--enabled-tools Execute --system-prompt "untrusted"',
          INPUT_ALLOWED_TOOLS: "Execute",
          INPUT_MCP_TOOLS: '{"mcpServers":{"unsafe":{"command":"false"}}}',
          INPUT_SETTINGS: '{"hooks":{"SessionStart":[{"command":"false"}]}}',
          INPUT_EXPERIMENTAL_SLASH_COMMANDS_DIR: directory,
          GITHUB_TOKEN: "fixture-github-token",
          WORKFLOW_GITHUB_TOKEN: "fixture-workflow-token",
          COMMAND_ACTOR: "attacker",
          COMMAND_PUBLISHER_PATH: "/not-authority",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({
      exitCode,
      stderr,
      failed: stdout.includes("Action failed"),
    }).toEqual({ exitCode: 0, stderr: "", failed: false });
    const captured = object(JSON.parse(await readFile(capturePath, "utf8")));
    const capturedEnv = object(captured.env);
    const cwd = String(captured.cwd);
    try {
      expect(cwd).not.toBe(directory);
      expect(capturedEnv.HOME).not.toBe(process.env.HOME);
      for (const key of [
        "GITHUB_TOKEN",
        "WORKFLOW_GITHUB_TOKEN",
        "INPUT_SETTINGS",
        "COMMAND_ACTOR",
        "COMMAND_PUBLISHER_PATH",
        "NODE_OPTIONS",
      ])
        expect(capturedEnv[key]).toBeUndefined();
      expect(capturedEnv.FACTORY_API_KEY).toBe("fixture-factory-key");
      expect(JSON.stringify(captured.args)).not.toContain("untrusted");
      expect(JSON.stringify(captured.args)).not.toContain("Execute");
      expect(JSON.stringify(captured.args)).toContain(
        "Read,Grep,Glob,LS,Edit,Create,ApplyPatch",
      );
      expect(
        JSON.parse(
          await readFile(path.join(cwd, ".factory/settings.json"), "utf8"),
        ),
      ).toEqual({ hooksDisabled: true });
      expect(
        JSON.parse(await readFile(path.join(cwd, ".factory/mcp.json"), "utf8")),
      ).toEqual({ mcpServers: {} });
    } finally {
      if (
        cwd !== directory &&
        path.basename(cwd) === "workspace" &&
        path.basename(path.dirname(cwd)).startsWith("droid-command-profile-")
      )
        await rm(path.dirname(cwd), { recursive: true, force: true });
    }
  });

  it("answers only a verified thread without invoking branch mutation APIs", async () => {
    const api = reviewBoundary();
    const outputPath = path.join(directory, "answer.txt");
    await writeFile(outputPath, "The guard prevents the invalid request.");
    await postCommand(api.octokit, {
      ...binding,
      mode: "question",
      fixMode: "off",
      outputPath,
      rootCommentId: 19,
      success: true,
    });
    expect(
      api.calls.filter((call) =>
        call.url.pathname.endsWith("/comments/19/replies"),
      ),
    ).toHaveLength(1);
    expect(api.calls.some((call) => call.url.pathname.includes("/git/"))).toBe(
      false,
    );
  });

  it("publishes only the allowed file with immutable parent, original mode, and non-force ref update", async () => {
    const api = fixBoundary();
    const result = await publishReviewFix(api.octokit, binding, proposal);
    expect(result.sha).toBe(FIXED);
    expect(result.body).toContain("Tests were not run");
    expect(
      api.calls.find(
        (call) =>
          call.method === "POST" && call.url.pathname.endsWith("/git/commits"),
      )?.body.parents,
    ).toEqual([HEAD]);
    expect(
      api.calls.find(
        (call) =>
          call.method === "POST" && call.url.pathname.endsWith("/git/trees"),
      )?.body.tree,
    ).toEqual([
      { path: "src/a.ts", type: "blob", mode: "100755", sha: "new-blob" },
    ]);
    expect(
      api.calls.find((call) => call.method === "PATCH")?.body,
    ).toMatchObject({ sha: FIXED, force: false });
  });

  for (const scenario of [
    "default-branch",
    "fork-actor",
    "symlink",
    "unselected-path",
  ] as const) {
    it(`refuses unsafe fix destination or file: ${scenario}`, async () => {
      const api = fixBoundary({
        defaultBranch: scenario === "default-branch" ? "feature" : undefined,
        fork: scenario === "fork-actor",
        symlink: scenario === "symlink",
      });
      const raw =
        scenario === "unselected-path"
          ? {
              ...proposal,
              files: [{ path: "unrelated.ts", content: "not permitted\n" }],
            }
          : proposal;
      await expect(
        publishReviewFix(api.octokit, binding, raw),
      ).rejects.toThrow();
      expect(writes(api.calls)).toEqual([]);
      if (scenario === "fork-actor")
        expect(
          api.calls.some((call) =>
            call.url.pathname.includes(
              "/fork-owner/repo/collaborators/maintainer/permission",
            ),
          ),
        ).toBe(true);
    });
  }

  it("aborts a head race without updating or creating any branch", async () => {
    const api = fixBoundary({ headMoves: true });
    await expect(
      publishReviewFix(api.octokit, binding, proposal),
    ).rejects.toThrow("head changed");
    expect(
      api.calls.some((call) => call.url.pathname.includes("/git/refs")),
    ).toBe(false);
    expect(
      api.calls.some(
        (call) =>
          call.method === "POST" && call.url.pathname.endsWith("/pulls"),
      ),
    ).toBe(false);
  });

  it("uses a fresh stacked branch for a protected source branch", async () => {
    const api = fixBoundary({ protected: true });
    const result = await publishReviewFix(api.octokit, binding, proposal);
    expect(result.url).toBe("https://github.example/base/repo/pull/8");
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
    expect(
      api.calls.find(
        (call) =>
          call.method === "POST" && call.url.pathname.endsWith("/git/refs"),
      )?.body,
    ).toEqual({
      ref: `refs/heads/droid/fix-7-${FIXED.slice(0, 12)}`,
      sha: FIXED,
    });
    expect(
      api.calls.find(
        (call) =>
          call.method === "POST" && call.url.pathname.endsWith("/pulls"),
      )?.body.base,
    ).toBe("feature");
  });
});
