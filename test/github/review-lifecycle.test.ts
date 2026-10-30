import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import * as core from "@actions/core";
import * as childProcess from "child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Octokits } from "../../src/github/api/client";
import { createMockContext } from "../mockContext";
import { normalizeFinding } from "../../src/core/review/validated/finding";
import {
  decodeReviewState,
  encodeFindingMarker,
  encodeReviewState,
  SUMMARY_MARKER,
  type ReviewState,
} from "../../src/core/review/markers";
import { prepareDroidTrackingCommentBody } from "../../src/github/operations/comments/common";
import {
  authoritativeReviewTarget,
  findReviewSummary,
  finishReviewLifecycle,
  listDroidThreads,
  loadBoundReviewLifecycle,
  prepareReviewLifecycle,
  readReviewLifecycle,
  replaceReviewDescription,
  saveReviewLifecycle,
  fetchImmutableReviewDiff,
} from "../../src/github/operations/review-lifecycle";
import { reviewCheckConclusion } from "../../src/github/operations/review-checks";
import { run as postReview } from "../../src/entrypoints/github-post-review";
import { run as lifecyclePhase } from "../../src/entrypoints/github-review-lifecycle";
import {
  changedFindingCandidates,
  identicalReviewDiffSkipReason,
  planIncrementalReview,
  reconcileFindings,
} from "../../src/core/review/incremental";
import { retryWithBackoff } from "../../src/utils/retry";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const BASE = "c".repeat(40);
const DIFF =
  "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n";
const finding = (overrides: Record<string, unknown> = {}) =>
  normalizeFinding({
    id: "f-known",
    title: "Requests lose their timeout",
    severity: "P1",
    path: "src/x.ts",
    line: 1,
    body: "Requests hang when the timeout is absent.",
    why: "The cancellation guard is missing.",
    verification: "Traced the request path.",
    ...overrides,
  });

describe("review lifecycle production boundaries", () => {
  let savedEnv: NodeJS.ProcessEnv;
  let directory: string;
  let outputs: Record<string, string>;
  beforeEach(async () => {
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env))
      if (
        /^(?:REVIEW_|DROID_|REPO_|PR_NUMBER|FAIL_ON_|SECURITY_|WORKFLOW_GITHUB|GITHUB_STEP_SUMMARY)/.test(
          key,
        )
      )
        delete process.env[key];
    directory = await mkdtemp(join(tmpdir(), "review-lifecycle-"));
    Object.assign(process.env, {
      RUNNER_TEMP: directory,
      GITHUB_RUN_ID: "123",
      REPO_OWNER: "o",
      REPO_NAME: "r",
      PR_NUMBER: "7",
      REVIEW_HEAD_SHA: HEAD,
      REVIEW_BASE_SHA: BASE,
    });
    await mkdir(join(directory, "droid-prompts"));
    outputs = {};
    spyOn(core, "setOutput").mockImplementation((name, value) => {
      outputs[name] = String(value);
    });
    spyOn(core, "warning").mockImplementation(() => {});
    spyOn(childProcess, "execFileSync").mockReturnValue(DIFF);
  });
  afterEach(async () => {
    mock.restore();
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(directory, { recursive: true, force: true });
  });
  function fixture(prior = [finding()]) {
    let checkExternalId = "123:1";
    let targetHead = HEAD;
    const calls: Array<{ method: string; input: any }> = [];
    const state: ReviewState = {
      head: OLD,
      findings: prior.map((f) => ({
        id: f.id,
        sev: f.severity,
        state: "open" as const,
        finding: f,
        commentId: 81,
        threadId: "T81",
        url: "https://github.com/o/r/pull/7#discussion_r81",
      })),
    };
    let body = `${SUMMARY_MARKER}\n${encodeReviewState(state)}`;
    let liveHead = HEAD;
    let description =
      "Preserves cancellation and handles the timeout. Fixes #12.";
    let threads: any[] = [];
    const record = (method: string, input: any) =>
      calls.push({ method, input });
    const octokit = {
      rest: {
        issues: {
          listComments: async (input: any) => {
            record("listComments", input);
            return {
              data: [
                {
                  id: 40,
                  body,
                  user: { id: 138933559, login: "factory-droid[bot]" },
                },
              ],
            };
          },
          getComment: async (input: any) => {
            record("getComment", input);
            return {
              data: {
                id: 40,
                body,
                issue_url: "https://api.github.com/repos/o/r/issues/7",
                user: { id: 138933559 },
              },
            };
          },
          createComment: async (input: any) => {
            record("createComment", input);
            body = input.body;
            return { data: { id: 40 } };
          },
          updateComment: async (input: any) => {
            record("updateComment", input);
            body = input.body;
            return { data: { id: 40 } };
          },
        },
        checks: {
          create: async (input: any) => {
            record("checkCreate", input);
            checkExternalId = input.external_id;
            return { data: { id: 50 } };
          },
          get: async (input: any) => {
            record("checkGet", input);
            return {
              data: {
                id: 50,
                external_id: checkExternalId,
                name: "Droid Review",
                head_sha: targetHead,
                status: "in_progress",
              },
            };
          },
          update: async (input: any) => {
            record("checkUpdate", input);
            return { data: {} };
          },
        },
        reactions: {
          createForIssue: async (input: any) => {
            record("reactionCreate", input);
            return { data: { id: 60 } };
          },
          deleteForIssue: async (input: any) => {
            record("reactionDelete", input);
            return { data: {} };
          },
        },
        pulls: {
          get: async (input: any) => {
            record("getPR", input);
            return {
              data: {
                head: { sha: liveHead },
                base: { sha: BASE },
                title: "Fix request timeouts",
                body: description,
              },
            };
          },
          createReview: async (input: any) => {
            record("createReview", input);
            return { data: { id: 70 } };
          },
          listCommentsForReview: async () => ({
            data:
              calls
                .filter((call) => call.method === "createReview")
                .at(-1)
                ?.input.comments.map((comment: any, i: number) => ({
                  id: 81 + i,
                  body: comment.body,
                  html_url: `https://github.com/o/r/pull/7#discussion_r${81 + i}`,
                })) || [],
          }),
          listReviews: async () => ({ data: [] }),
          updateReview: async (input: any) => {
            record("updateReview", input);
            return { data: {} };
          },
          update: async (input: any) => {
            record("updatePR", input);
            description = input.body;
            return { data: {} };
          },
          createReplyForReviewComment: async (input: any) => {
            record("reply", input);
            return { data: { id: 82 } };
          },
        },
        repos: {
          compareCommitsWithBasehead: async (input: any) => {
            record("compare", input);
            return { data: DIFF };
          },
          getContent: async (input: any) => {
            record("getContent", input);
            return {
              data: {
                content: Buffer.from("* @alice").toString("base64"),
                encoding: "base64",
                size: 8,
              },
            };
          },
        },
      },
      graphql: async (query: string, input: any) => {
        if (query.includes("DroidViewer"))
          return { viewer: { login: "factory-droid[bot]" } };
        record("graphql", { query, input });
        if (query.includes("DroidReviewThreads"))
          return {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: threads,
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        if (query.includes("DroidReopenThread"))
          return {
            unresolveReviewThread: {
              thread: { id: input.id, isResolved: false },
            },
          };
        return {
          resolveReviewThread: { thread: { id: input.id, isResolved: true } },
        };
      },
    } as unknown as Octokits;
    const context = createMockContext({
      eventName: "pull_request",
      isPR: true,
      entityNumber: 7,
      runId: "123",
      repository: { owner: "o", repo: "r", full_name: "o/r" },
    });
    async function prepare(runAttempt?: string) {
      const result = await prepareReviewLifecycle({
        octokit,
        context,
        headSha: targetHead,
        baseSha: BASE,
        ...(runAttempt ? { runAttempt } : {}),
      });
      for (const [name, value] of Object.entries(outputs))
        process.env[name.toUpperCase()] = value;
      return result;
    }
    async function post(
      results: unknown[],
      resolutions?: unknown[],
      reviewSession?: { runId: string; runAttempt?: string },
    ) {
      await writeFile(
        join(directory, "droid-prompts/pr.diff"),
        "model can rewrite this artifact",
      );
      await writeFile(
        join(directory, "droid-prompts/review_validated.json"),
        JSON.stringify({
          meta: { headSha: targetHead },
          results,
          findingResolutions: resolutions,
          reviewSummary: { body: "Review complete." },
        }),
      );
      return postReview({
        context,
        octokit,
        ...(reviewSession ? { reviewSession } : {}),
      });
    }
    function setThreads(
      resolved: boolean,
      author = 138933559,
      line = 1,
      side: "LEFT" | "RIGHT" = "RIGHT",
    ) {
      threads = [
        {
          id: "T81",
          isResolved: resolved,
          path: "src/x.ts",
          line,
          diffSide: side,
          startLine: null,
          comments: {
            nodes: [
              {
                databaseId: 81,
                body: encodeFindingMarker({
                  id: "f-known",
                  sev: "P1",
                  head: OLD,
                }),
                url: "https://github.com/o/r/pull/7#discussion_r81",
                author: {
                  databaseId: author,
                  login: author === 138933559 ? "factory-droid[bot]" : "human",
                },
              },
            ],
          },
        },
      ];
    }
    return {
      calls,
      octokit,
      context,
      prepare,
      post,
      setThreads,
      setMemoryState: (
        status: "open" | "resolved" | "dismissed",
        fields: object = {},
      ) => {
        state.findings[0] = {
          ...state.findings[0]!,
          state: status,
          finding: { ...prior[0]!, ...fields },
        };
        body = `${SUMMARY_MARKER}\n${encodeReviewState(state)}`;
      },
      nextHead: () => {
        targetHead = "d".repeat(40);
        liveHead = targetHead;
        process.env.REVIEW_HEAD_SHA = targetHead;
      },
      body: () => body,
      setSummary: (next: string, head = HEAD) => {
        body = next;
        liveHead = head;
      },
      description: () => description,
      setDescription: (next: string) => {
        description = next;
      },
    };
  }
  it("refuses attempt A after attempt B on the same workflow run and keeps B valid", async () => {
    const f = fixture([]);
    process.env.GITHUB_RUN_ATTEMPT = "1";
    const a = await f.prepare();
    process.env.GITHUB_RUN_ATTEMPT = "2";
    const b = await f.prepare();
    const ownedByB = f.body();
    await finishReviewLifecycle({
      octokit: f.octokit,
      run: a.run,
      input: { state: "clean" },
    });
    const afterA = f.body();
    await finishReviewLifecycle({
      octokit: f.octokit,
      run: b.run,
      input: { state: "clean" },
    });
    expect(afterA).toBe(ownedByB);
    expect(f.body()).toContain(`run=123 attempt=2 -->`);
    expect(f.body()).toContain("Looks good to merge");
  });
  it("uses the trusted prepared attempt at post when ambient attempt is absent and cache is poisoned", async () => {
    const f = fixture([]);
    process.env.GITHUB_RUN_ATTEMPT = "2";
    const prepared = await f.prepare();
    const reviewSession = JSON.parse(
      JSON.stringify({ runId: "123", runAttempt: "2" }),
    );
    const cache = (await readReviewLifecycle())!;
    Object.assign(cache, { runAttempt: "99" });
    await saveReviewLifecycle(cache);
    delete process.env.GITHUB_RUN_ATTEMPT;
    await f.post([], undefined, reviewSession);
    expect(prepared.run).toHaveProperty("runAttempt", "2");
    expect(f.body()).toContain("droid-review-completed:v1");
    expect(f.body()).toContain("run=123 attempt=2 -->");
  });
  it("does not let a legacy unknown-attempt marker authenticate attempt 2", async () => {
    const f = fixture([]);
    process.env.GITHUB_RUN_ATTEMPT = "2";
    await f.prepare();
    f.setSummary(
      `${SUMMARY_MARKER}\n<!-- droid-review-active:v1 head=${HEAD} run=123 -->`,
    );
    const loaded = await loadBoundReviewLifecycle(f.octokit);
    expect(loaded?.superseded).toBe(true);
  });
  it("does not downgrade known attempt 2 when an optional identity omits its attempt", async () => {
    const f = fixture([]);
    process.env.GITHUB_RUN_ATTEMPT = "2";
    await f.prepare();
    const legacy = `${SUMMARY_MARKER}\n<!-- droid-review-active:v1 head=${HEAD} run=123 -->`;
    f.setSummary(legacy);
    await expect(f.post([], undefined, { runId: "123" })).rejects.toThrow(
      "superseded",
    );
    expect(f.body()).toBe(legacy);
  });
  it("captures the attempt before preparation awaits and retains legacy attempt 1 compatibility", async () => {
    const f = fixture([]);
    process.env.GITHUB_RUN_ATTEMPT = "1";
    const pending = f.prepare();
    process.env.GITHUB_RUN_ATTEMPT = "2";
    const prepared = await pending;
    expect(prepared.run.runAttempt).toBe("1");
    process.env.GITHUB_RUN_ATTEMPT = "1";
    f.setSummary(
      `${SUMMARY_MARKER}\n<!-- droid-review-active:v1 head=${HEAD} run=123 -->`,
    );
    const loaded = await loadBoundReviewLifecycle(f.octokit);
    expect(loaded?.superseded).toBe(false);
    await finishReviewLifecycle({
      octokit: f.octokit,
      run: loaded!,
      input: { state: "clean" },
    });
    expect(f.body()).toContain("droid-review-completed:v1");
    expect(f.body()).toContain("run=123 attempt=1 -->");
  });
  it.each([false, true])(
    "rejects conflicting declared provenance before publication (outside=%s)",
    async (outside) => {
      const f = fixture([]);
      await f.prepare();
      f.calls.length = 0;
      await expect(
        f.post([
          {
            status: "approved",
            comment: {
              ...finding(),
              commit_id: OLD,
              outside_diff: outside,
            },
          },
        ]),
      ).rejects.toThrow("conflicting");
      expect(f.calls.some((call) => call.method === "createReview")).toBe(
        false,
      );
      expect(f.calls.some((call) => call.method === "updateComment")).toBe(
        false,
      );
    },
  );
  it.each([false, true])(
    "rechecks ownership after awaited publication (head changed=%s)",
    async (changedHead) => {
      const f = fixture([]);
      await f.prepare();
      const newerHead = changedHead ? OLD : HEAD;
      const newer = `${SUMMARY_MARKER}\n${encodeReviewState({ head: newerHead, findings: [] })}\n<!-- droid-review-active:v1 head=${newerHead} run=456 -->`;
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      spyOn(f.octokit.rest.pulls, "createReview").mockImplementation(
        (async () => {
          entered();
          await blocked;
          return { data: { id: 70 } };
        }) as any,
      );
      f.calls.length = 0;
      const posting = f.post([{ status: "approved", comment: finding() }]);
      await waiting;
      f.setSummary(newer, newerHead);
      release();
      await posting;
      expect(f.body()).toBe(newer);
      expect(f.calls.some((call) => call.method === "updateComment")).toBe(
        false,
      );
    },
  );
  it("does not infer this run completed from a competing active marker at the same head", async () => {
    const f = fixture([]);
    await f.prepare();
    f.setSummary(
      `${SUMMARY_MARKER}\n${encodeReviewState({ head: HEAD, findings: [] })}\n<!-- droid-review-active:v1 head=${HEAD} run=456 -->`,
    );
    const bound = await loadBoundReviewLifecycle(f.octokit);
    expect(bound?.completed).toBe(false);
    expect(bound?.superseded).toBe(true);
  });
  it("does not accept an active-marker example in a fenced block as ownership", async () => {
    const f = fixture([]);
    const prepared = await f.prepare();
    const newer = `${SUMMARY_MARKER}\n\`\`\`md\n<!-- droid-review-active:v1 head=${HEAD} run=123 -->\n\`\`\`\n<!-- droid-review-active:v1 head=${HEAD} run=456 -->`;
    f.setSummary(newer);
    await finishReviewLifecycle({
      octokit: f.octokit,
      run: prepared.run,
      input: { state: "clean" },
    });
    expect(f.body()).toBe(newer);
  });
  it("recognizes its own completed session without repeating publication", async () => {
    const f = fixture([]);
    await f.prepare();
    await f.post([]);
    f.calls.length = 0;
    const bound = await loadBoundReviewLifecycle(f.octokit);
    expect(bound?.completed).toBe(true);
    await finishReviewLifecycle({ octokit: f.octokit, run: bound! });
    expect(f.calls.some((call) => call.method === "updateComment")).toBe(false);
  });
  it("keeps a later preparation owned without inheriting the previous session marker", async () => {
    const f = fixture([]);
    await f.prepare();
    await f.post([]);
    await f.prepare();
    await f.post([]);
    expect(f.body()).toContain("Looks good to merge");
    expect(f.body().match(/droid-review-completed:v1/g) || []).toHaveLength(1);
  });
  it.each(["post", "finalizer"])(
    "recovers its own applied terminal sticky after a lost response through %s",
    async (route) => {
      process.env.REVIEW_SUMMARY = "description";
      process.env.GITHUB_RUN_ATTEMPT = "2";
      const f = fixture([]);
      await f.prepare();
      const apply = f.octokit.rest.issues.updateComment;
      let attempts = 0;
      const update = spyOn(
        f.octokit.rest.issues,
        "updateComment",
      ).mockImplementation((async (input: any) => {
        const result = await apply(input);
        if (++attempts === 1)
          throw new Error("terminal PATCH applied, response lost");
        return result;
      }) as any);
      if (route === "post") await f.post([]);
      else {
        process.env.REVIEW_PHASE = "finalize";
        process.env.DROID_SUCCESS = "false";
        await lifecyclePhase({ octokit: f.octokit });
      }
      expect(update).toHaveBeenCalledTimes(2);
      expect(f.body()).toContain(
        `droid-review-completed:v1 head=${HEAD} run=123 attempt=2 -->`,
      );
      expect(f.description()).toContain(
        route === "post" ? "Looks good to merge" : "couldn't finish",
      );
      expect(f.description()).not.toContain("Droid is reviewing");
      const completed = (await readReviewLifecycle())!;
      expect(completed.completed).toBe(true);
      expect(completed.superseded).toBe(false);
    },
  );
  it.each([
    ["456", "2", HEAD],
    ["123", "3", HEAD],
    ["123", "2", OLD],
  ])(
    "rejects a foreign completed session after a lost terminal response (run=%s attempt=%s head=%s)",
    async (runId, runAttempt, head) => {
      process.env.REVIEW_SUMMARY = "description";
      process.env.GITHUB_RUN_ATTEMPT = "2";
      const f = fixture([]);
      await f.prepare();
      const description = f.description();
      const foreign = `${SUMMARY_MARKER}\n<!-- droid-review-completed:v1 head=${head} run=${runId} attempt=${runAttempt} -->`;
      const apply = f.octokit.rest.issues.updateComment;
      const update = spyOn(
        f.octokit.rest.issues,
        "updateComment",
      ).mockImplementation((async (input: any) => {
        await apply(input);
        f.setSummary(foreign);
        throw new Error(
          "terminal PATCH applied, a competing session won, response lost",
        );
      }) as any);
      await f.post([]);
      expect(update).toHaveBeenCalledTimes(1);
      expect(f.body()).toBe(foreign);
      expect(f.description()).toBe(description);
      expect((await readReviewLifecycle())?.superseded).toBe(true);
    },
  );
  it("rechecks session ownership before retrying an ambiguous sticky update", async () => {
    const f = fixture([]);
    const prepared = await f.prepare();
    const newer = `${SUMMARY_MARKER}\n<!-- droid-review-active:v1 head=${HEAD} run=456 -->`;
    const update = spyOn(
      f.octokit.rest.issues,
      "updateComment",
    ).mockImplementation((async () => {
      f.setSummary(newer);
      throw new Error("connection lost before confirmation");
    }) as any);
    await finishReviewLifecycle({
      octokit: f.octokit,
      run: prepared.run,
      input: { state: "clean" },
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(f.body()).toBe(newer);
  });
  it("preserves current author description bytes at the actual publication boundary", async () => {
    process.env.REVIEW_SUMMARY = "description";
    const f = fixture([]);
    const author =
      "Author text\r\n\r\n```md\r\n<!-- droid-review-summary:start -->\r\nexample\r\n<!-- droid-review-summary:end -->\r\n```\r\n";
    f.setDescription(author);
    await f.prepare();
    const edited = `Updated author preface\r\n${f.description()}`;
    f.setDescription(edited);
    await f.post([]);
    expect(
      f.description().startsWith(`Updated author preface\r\n${author}`),
    ).toBe(true);
    expect(f.description()).toContain("Looks good to merge");
    expect(f.body()).toContain(
      `droid-review-completed:v1 head=${HEAD} run=123`,
    );
  });
  it("does not update a newer run's description after ownership changes", async () => {
    process.env.REVIEW_SUMMARY = "description";
    const f = fixture([]);
    const prepared = await f.prepare();
    const newer = `${SUMMARY_MARKER}\n<!-- droid-review-active:v1 head=${HEAD} run=456 -->`;
    f.setSummary(newer);
    f.setDescription("New author description owned by the newer run.");
    f.calls.length = 0;
    await finishReviewLifecycle({
      octokit: f.octokit,
      run: prepared.run,
      input: { state: "clean" },
    });
    expect(f.description()).toBe(
      "New author description owned by the newer run.",
    );
    expect(
      f.calls.some(
        (call) => call.method === "updatePR" || call.method === "updateComment",
      ),
    ).toBe(false);
  });
  it("trusted check identity posts attempt 2 with ambient metadata absent and cache poisoned", async () => {
    const f = fixture([]);
    process.env.GITHUB_RUN_ATTEMPT = "2";
    await f.prepare();
    const cached = (await readReviewLifecycle())!;
    Object.assign(cached, { runId: "999", runAttempt: "99" });
    await saveReviewLifecycle(cached);
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ATTEMPT;
    f.calls.length = 0;
    await f.post([], undefined, { runId: "123", runAttempt: "2" });
    const updates = f.calls.filter((c) => c.method === "checkUpdate");
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((c) => c.input.check_run_id === 50)).toBe(true);
    expect(updates.at(-1)!.input).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
  });
  it("trusted check identity creates and posts explicit attempt 2 without ambient metadata", async () => {
    const f = fixture([]);
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ATTEMPT;
    const prepared = await f.prepare("2");
    expect(prepared.run).toMatchObject({ runId: "123", runAttempt: "2" });
    expect(
      f.calls.find((c) => c.method === "checkCreate")!.input.external_id,
    ).toBe("123:2");
    await f.post([], undefined, { runId: "123", runAttempt: "2" });
    expect(
      f.calls.filter((c) => c.method === "checkUpdate").at(-1)!.input,
    ).toMatchObject({
      check_run_id: 50,
      status: "completed",
      conclusion: "success",
    });
  });
  it("trusted check identity rejects a real own check from a different attempt", async () => {
    const f = fixture([]);
    process.env.GITHUB_RUN_ATTEMPT = "2";
    await f.prepare();
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ATTEMPT;
    f.calls.length = 0;
    await expect(
      f.post([], undefined, { runId: "123", runAttempt: "3" }),
    ).rejects.toThrow("does not belong");
    expect(f.calls.filter((c) => c.method === "checkUpdate")).toEqual([]);
  });
  it("trusted check identity uses known ambient attempt when the optional identity omits it", async () => {
    const f = fixture([]);
    process.env.GITHUB_RUN_ATTEMPT = "2";
    await f.prepare();
    await f.post([], undefined, { runId: "123" });
    expect((await readReviewLifecycle())?.runAttempt).toBe("2");
    expect(
      f.calls.filter((c) => c.method === "checkUpdate").at(-1)!.input,
    ).toMatchObject({
      check_run_id: 50,
      status: "completed",
      conclusion: "success",
    });
  });
  it("trusted check identity captures the attempt before preparation awaits", async () => {
    const f = fixture([]);
    process.env.GITHUB_RUN_ATTEMPT = "2";
    const pending = f.prepare();
    process.env.GITHUB_RUN_ATTEMPT = "3";
    await pending;
    expect(
      f.calls.find((c) => c.method === "checkCreate")!.input.external_id,
    ).toBe("123:2");
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ATTEMPT;
    await f.post([], undefined, { runId: "123", runAttempt: "2" });
    expect(
      f.calls.filter((c) => c.method === "checkUpdate").at(-1)!.input.status,
    ).toBe("completed");
  });
  it("trusted check identity finalizes attempt 2 through the actual entrypoint without ambient metadata", async () => {
    const f = fixture([]);
    process.env.GITHUB_RUN_ATTEMPT = "2";
    await f.prepare();
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ATTEMPT;
    process.env.DROID_SUCCESS = "false";
    f.calls.length = 0;
    await lifecyclePhase({
      octokit: f.octokit,
      reviewSession: { runId: "123", runAttempt: "2" },
    });
    expect(
      f.calls.filter((c) => c.method === "checkUpdate").at(-1)!.input,
    ).toMatchObject({
      check_run_id: 50,
      status: "completed",
      conclusion: "neutral",
    });
  });
  it.each(["queued", "in_progress"])(
    "finalizes only its own %s check after another same-head run completes",
    async (status) => {
      const f = fixture([]);
      await f.prepare();
      const otherSummary = `${SUMMARY_MARKER}\n${encodeReviewState({ head: HEAD, findings: [] })}\n<!-- droid-review-completed:v1 head=${HEAD} run=456 -->`;
      f.setSummary(otherSummary);
      spyOn(f.octokit.rest.checks, "get").mockResolvedValue({
        data: {
          id: 50,
          external_id: "123:1",
          name: "Droid Review",
          head_sha: HEAD,
          status,
        },
      } as any);
      f.calls.length = 0;
      const bound = await loadBoundReviewLifecycle(f.octokit);
      expect(bound?.completed).toBe(false);
      await finishReviewLifecycle({
        octokit: f.octokit,
        run: bound!,
        input: { state: "clean" },
      });
      const updates = f.calls.filter((call) => call.method === "checkUpdate");
      expect(updates).toHaveLength(1);
      expect(updates[0]!.input).toMatchObject({
        check_run_id: 50,
        status: "completed",
      });
      expect(f.body()).toBe(otherSummary);
    },
  );
  it("does not adopt an unrelated same-head check with a different run binding", async () => {
    const f = fixture([]);
    await f.prepare();
    spyOn(f.octokit.rest.checks, "get").mockResolvedValue({
      data: {
        id: 50,
        external_id: "456:1",
        name: "Droid Review",
        head_sha: HEAD,
        status: "in_progress",
      },
    } as any);
    f.calls.length = 0;
    await expect(loadBoundReviewLifecycle(f.octokit)).rejects.toThrow(
      "does not belong",
    );
    expect(f.calls.some((call) => call.method === "checkUpdate")).toBe(false);
  });
  it("does not repeat a completed own check", async () => {
    const f = fixture([]);
    await f.prepare();
    spyOn(f.octokit.rest.checks, "get").mockResolvedValue({
      data: {
        id: 50,
        external_id: "123:1",
        name: "Droid Review",
        head_sha: HEAD,
        status: "completed",
      },
    } as any);
    f.calls.length = 0;
    const bound = await loadBoundReviewLifecycle(f.octokit);
    await finishReviewLifecycle({ octokit: f.octokit, run: bound! });
    expect(f.calls.some((call) => call.method === "checkUpdate")).toBe(false);
  });
  it("does not duplicate a check whose creation applied but lost its response", async () => {
    const f = fixture([]);
    const created: unknown[] = [];
    const create = spyOn(f.octokit.rest.checks, "create").mockImplementation(
      (async (input: unknown) => {
        created.push(input);
        throw new Error("connection reset after remote creation");
      }) as any,
    );
    const prepared = await f.prepare();
    expect(create).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(prepared.run.checkId).toBeUndefined();
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(f.calls.some((call) => call.method === "checkUpdate")).toBe(false);
  });
  it("binds successful check creation to this workflow run and attempt", async () => {
    const f = fixture([]);
    const prepared = await f.prepare();
    expect(prepared.run.checkId).toBe(50);
    expect(
      f.calls.find((call) => call.method === "checkCreate")!.input,
    ).toMatchObject({
      head_sha: HEAD,
      external_id: "123:1",
      status: "queued",
    });
  });
  for (const control of [
    {
      name: "explicit restored fix",
      fixed: true,
      changed: true,
      human: false,
      state: "resolved",
    },
    {
      name: "absence is not fixed",
      fixed: false,
      changed: true,
      human: false,
      state: "open",
    },
    {
      name: "unchanged path is not eligible",
      fixed: true,
      changed: false,
      human: false,
      state: "open",
    },
    {
      name: "human resolution wins",
      fixed: true,
      changed: true,
      human: true,
      state: "dismissed",
    },
  ] as const) {
    it(`incremental safety v2: LEFT JSON parser to publisher, ${control.name}`, async () => {
      const f = fixture([]);
      const deletion =
        "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -8 +7,0 @@\n-guard();\n";
      const compare = spyOn(
        f.octokit.rest.repos,
        "compareCommitsWithBasehead",
      ).mockResolvedValue({ data: deletion } as any);
      await f.prepare();
      const posted = await f.post([
        {
          status: "approved",
          comment: {
            id: "f-known",
            severity: "P1",
            title: "Restore the deleted request guard",
            path: "src/x.ts",
            side: "LEFT",
            old_path: "src/x.ts",
            old_line: 8,
            line: null,
            body: "Removing this guard lets requests run without cancellation.",
          },
        },
      ]);
      expect(posted.posted).toBe(1);
      expect(
        f.calls.find((call) => call.method === "createReview")?.input
          .comments[0],
      ).toMatchObject({ path: "src/x.ts", side: "LEFT", line: 8 });
      expect(decodeReviewState(f.body())?.findings[0]?.finding).toMatchObject({
        id: "f-known",
        path: "src/x.ts",
        side: "LEFT",
        line: 8,
      });

      const insertion =
        "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -7,0 +8 @@\n+guard();\n";
      const unrelated = insertion.replaceAll("src/x.ts", "src/other.ts");
      const priorDiff = control.changed ? insertion : unrelated;
      spyOn(childProcess, "execFileSync").mockReturnValue(priorDiff);
      compare.mockResolvedValue({ data: priorDiff } as any);
      f.nextHead();
      f.setThreads(control.human, 138933559, 8, "LEFT");
      await f.prepare();
      await f.post(
        [],
        control.fixed
          ? [
              {
                id: "f-known",
                status: "fixed",
                evidence:
                  "The deleted guard is restored at the request entry point.",
              },
            ]
          : undefined,
      );

      expect(decodeReviewState(f.body())?.findings[0]?.state).toBe(
        control.state,
      );
      expect(
        f.calls.filter((call) => call.method === "createReview"),
      ).toHaveLength(1);
      expect(f.calls.filter((call) => call.method === "reply")).toHaveLength(
        control.state === "resolved" ? 1 : 0,
      );
      expect(
        f.calls.filter(
          (call) =>
            call.method === "graphql" &&
            call.input.query.includes("DroidResolveThread"),
        ),
      ).toHaveLength(control.state === "resolved" ? 1 : 0);
    });
  }
  for (const threadResolved of [false, true]) {
    it(`incremental safety: reopens auto-fixed recurrence with thread resolved=${threadResolved}`, async () => {
      process.env.FAIL_ON_SEVERITY = "P1";
      const f = fixture();
      f.setMemoryState("resolved", { fixedIn: OLD });
      f.setThreads(threadResolved);
      await f.prepare();
      await f.post([{ status: "approved", comment: finding() }]);
      const memory = decodeReviewState(f.body())!;
      expect(memory.findings[0]?.state).toBe("open");
      expect(f.calls.some((call) => call.method === "createReview")).toBe(
        false,
      );
      expect(
        f.calls.filter((call) => call.method === "checkUpdate").at(-1)?.input
          .conclusion,
      ).toBe("failure");
      expect(
        f.calls.some(
          (call) =>
            call.method === "graphql" &&
            call.input.query.includes("DroidReopenThread"),
        ),
      ).toBe(threadResolved);
    });
  }
  it("incremental safety: does not reopen human dismissals or repost unchanged open IDs", async () => {
    for (const status of ["dismissed", "open"] as const) {
      const f = fixture();
      f.setMemoryState(status);
      f.setThreads(status === "dismissed");
      await f.prepare();
      await f.post([{ status: "approved", comment: finding() }]);
      expect(decodeReviewState(f.body())?.findings[0]?.state).toBe(status);
      expect(f.calls.some((call) => call.method === "createReview")).toBe(
        false,
      );
      expect(
        f.calls.some(
          (call) =>
            call.method === "graphql" &&
            call.input.query.includes("DroidReopenThread"),
        ),
      ).toBe(false);
    }
  });
  it("incremental safety: honors intentional resolution without auto-fix provenance and manual dismissal of pending work", async () => {
    for (const status of ["resolved", "dismissed"] as const) {
      const f = fixture();
      f.setMemoryState(
        status,
        status === "dismissed"
          ? { fixedIn: OLD, pendingThreadAction: "reopen" }
          : {},
      );
      f.setThreads(true);
      await f.prepare();
      await f.post([{ status: "approved", comment: finding() }]);
      expect(decodeReviewState(f.body())?.findings[0]?.state).toBe(status);
      expect(
        f.calls.some(
          (call) =>
            call.method === "graphql" &&
            call.input.query.includes("DroidReopenThread"),
        ),
      ).toBe(false);
      expect(f.calls.some((call) => call.method === "createReview")).toBe(
        false,
      );
    }
  });
  it("incremental safety: retains failed native reopening without mistaking it for human dismissal", async () => {
    process.env.FAIL_ON_SEVERITY = "P1";
    const f = fixture();
    f.setMemoryState("resolved", { fixedIn: OLD });
    f.setThreads(true);
    const graphql = f.octokit.graphql;
    let deny = true;
    let attempts = 0;
    spyOn(f.octokit, "graphql").mockImplementation((async (
      query: string,
      input: any,
    ) => {
      if (query.includes("DroidReopenThread")) {
        attempts++;
        if (deny)
          throw Object.assign(new Error("Synthetic permission denial"), {
            status: 403,
          });
      }
      return graphql(query, input);
    }) as typeof f.octokit.graphql);
    await f.prepare();
    await f.post([{ status: "approved", comment: finding() }]);
    expect(decodeReviewState(f.body())?.findings[0]?.state).toBe("open");
    expect(
      decodeReviewState(f.body())?.findings[0]?.finding?.pendingThreadAction,
    ).toBe("reopen");
    deny = false;
    f.nextHead();
    await f.prepare();
    await f.post([]);
    expect(attempts).toBe(2);
    expect(decodeReviewState(f.body())?.findings[0]?.state).toBe("open");
    expect(
      decodeReviewState(f.body())?.findings[0]?.finding?.pendingThreadAction,
    ).toBeUndefined();
    expect(
      f.calls.filter((call) => call.method === "checkUpdate").at(-1)?.input
        .conclusion,
    ).toBe("failure");
    expect(f.calls.some((call) => call.method === "createReview")).toBe(false);
  });
  it("incremental safety: rebases retained live locations before the next explicit fix", async () => {
    const f = fixture();
    f.setThreads(false, 138933559, 10);
    spyOn(childProcess, "execFileSync").mockReturnValue(
      "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -0,0 +1,9 @@\n+1\n+2\n+3\n+4\n+5\n+6\n+7\n+8\n+9\n",
    );
    await f.prepare();
    await f.post([]);
    const memory = decodeReviewState(f.body())!;
    expect(memory.head).toBe(HEAD);
    expect(memory.findings[0]?.finding?.line).toBe(10);
    expect(memory.findings[0]?.threadId).toBe("T81");
    expect(memory.findings[0]?.id).toBe("f-known");
    expect(f.calls.some((call) => call.method === "createReview")).toBe(false);
    f.nextHead();
    const shifted = DIFF.replaceAll("-1,2 +1,2", "-10,2 +10,2");
    spyOn(childProcess, "execFileSync").mockReturnValue(shifted);
    spyOn(f.octokit.rest.repos, "compareCommitsWithBasehead").mockResolvedValue(
      { data: shifted } as any,
    );
    await f.prepare();
    await f.post(
      [],
      [
        {
          id: "f-known",
          status: "fixed",
          evidence: "The shifted timeout guard is restored.",
        },
      ],
    );
    expect(decodeReviewState(f.body())?.findings[0]?.state).toBe("resolved");
  });
  it("incremental safety: retries failed owned resolutions without blocking fixed verdicts or duplicating replies", async () => {
    const f = fixture();
    f.setThreads(false);
    const graphql = f.octokit.graphql;
    let deny = true;
    spyOn(f.octokit, "graphql").mockImplementation((async (
      query: string,
      input: any,
    ) => {
      if (query.includes("DroidResolveThread") && deny)
        throw Object.assign(new Error("Synthetic permission denial"), {
          status: 403,
        });
      return graphql(query, input);
    }) as typeof f.octokit.graphql);
    await f.prepare();
    await f.post(
      [],
      [
        {
          id: "f-known",
          status: "fixed",
          evidence: "The timeout guard is restored.",
        },
      ],
    );
    const first = decodeReviewState(f.body())!;
    expect(first.findings[0]?.state).toBe("resolved");
    expect(first.findings[0]?.finding).toMatchObject({
      fixedIn: HEAD,
      pendingThreadAction: "resolve",
    });
    expect(
      f.calls.filter((call) => call.method === "checkUpdate").at(-1)?.input
        .conclusion,
    ).toBe("success");
    // A pending retry must not create another reply even if the thread page
    // has not exposed the earlier successful create yet.
    f.setThreads(false);
    deny = false;
    f.nextHead();
    await f.prepare();
    await f.post([]);
    expect(
      f.calls.filter(
        (call) =>
          call.method === "graphql" &&
          call.input.query.includes("DroidResolveThread"),
      ),
    ).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === "reply")).toHaveLength(1);
    expect(
      decodeReviewState(f.body())?.findings[0]?.finding?.pendingThreadAction,
    ).toBeUndefined();
    expect(f.calls.some((call) => call.method === "createReview")).toBe(false);
  });
  it("incremental safety: retries only native resolution after an ambiguous fixed-reply create", async () => {
    const f = fixture();
    f.setThreads(false);
    const failReply = Object.assign(async () => {
      throw Object.assign(new Error("Synthetic ambiguous reply"), {
        status: 500,
      });
    }, f.octokit.rest.pulls.createReplyForReviewComment);
    const reply = spyOn(
      f.octokit.rest.pulls,
      "createReplyForReviewComment",
    ).mockImplementation(failReply);
    await f.prepare();
    await f.post(
      [],
      [
        {
          id: "f-known",
          status: "fixed",
          evidence: "The timeout guard is restored.",
        },
      ],
    );
    expect(reply).toHaveBeenCalledTimes(1);
    expect(
      f.calls.filter(
        (call) =>
          call.method === "graphql" &&
          call.input.query.includes("DroidResolveThread"),
      ),
    ).toHaveLength(1);
    expect(decodeReviewState(f.body())?.findings[0]?.state).toBe("resolved");
    expect(
      decodeReviewState(f.body())?.findings[0]?.finding?.pendingThreadAction,
    ).toBeUndefined();
  });
  it("incremental safety: uses direct prior-tree comparison for divergent heads", async () => {
    const f = fixture();
    const direct = await fetchImmutableReviewDiff(f.octokit, {
      owner: "o",
      repo: "r",
      base: OLD,
      head: HEAD,
      direct: true,
    });
    expect(direct).toBe(DIFF);
    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      "git",
      [
        "--no-replace-objects",
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        `${OLD}..${HEAD}`,
      ],
      expect.objectContaining({ encoding: "utf8" }),
    );
    expect(f.calls.some((call) => call.method === "compare")).toBe(false);
  });
  it("incremental safety: ignores invalid live line coordinates", async () => {
    const f = fixture();
    f.setThreads(false, 138933559, -1);
    await f.prepare();
    await f.post([]);
    expect(decodeReviewState(f.body())?.findings[0]?.finding?.line).toBe(1);
    expect(decodeReviewState(f.body())?.findings[0]?.id).toBe("f-known");
    expect(f.calls.some((call) => call.method === "createReview")).toBe(false);
  });
  it("incremental safety: fails closed when a divergent prior tree is unavailable locally", async () => {
    const f = fixture();
    spyOn(childProcess, "execFileSync").mockImplementation(() => {
      throw new Error("Synthetic unavailable object");
    });
    const compare = spyOn(
      f.octokit.rest.repos,
      "compareCommitsWithBasehead",
    ).mockResolvedValue({ data: { merge_base_commit: { sha: BASE } } } as any);
    await expect(
      fetchImmutableReviewDiff(f.octokit, {
        owner: "o",
        repo: "r",
        base: OLD,
        head: HEAD,
        direct: true,
      }),
    ).rejects.toThrow("previous reviewed tree is unavailable");
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0]?.[0]).not.toHaveProperty("mediaType");
  });
  it("incremental safety: permits an authenticated ancestor comparison if local history is unavailable", async () => {
    const f = fixture();
    spyOn(childProcess, "execFileSync").mockImplementation(() => {
      throw new Error("Synthetic unavailable object");
    });
    const compare = spyOn(
      f.octokit.rest.repos,
      "compareCommitsWithBasehead",
    ).mockImplementation((async (input: any) => ({
      data: input.mediaType ? DIFF : { merge_base_commit: { sha: OLD } },
    })) as typeof f.octokit.rest.repos.compareCommitsWithBasehead);
    expect(
      await fetchImmutableReviewDiff(f.octokit, {
        owner: "o",
        repo: "r",
        base: OLD,
        head: HEAD,
        direct: true,
      }),
    ).toBe(DIFF);
    expect(compare).toHaveBeenCalledTimes(2);
  });
  it("uses real returned discussion links and deterministic inline markers", async () => {
    const f = fixture([]);
    await f.prepare();
    const result = await f.post([{ status: "approved", comment: finding() }]);
    expect(result.posted).toBe(1);
    expect(f.body()).toContain("#discussion_r81");
    const created = f.calls.find(
      (call) => call.method === "createReview",
    )!.input;
    expect(created.event).toBe("COMMENT");
    expect(created.comments[0].body).toContain("`P1`");
    expect(created.comments[0].body).not.toContain("<img");
    expect(created.comments[0].body).toContain("droid-finding:v1");
    expect(decodeReviewState(f.body())?.head).toBe(HEAD);
    expect(
      f.calls
        .filter((call) => call.method === "compare")
        .map((call) => call.input.basehead),
    ).toContain(`${BASE}...${HEAD}`);
  });
  it("finishes clean without an empty review, cleans its own eyes, and writes the step summary", async () => {
    process.env.GITHUB_STEP_SUMMARY = join(directory, "summary.md");
    const f = fixture([]);
    await f.prepare();
    await f.post([]);
    expect(f.calls.some((call) => call.method === "createReview")).toBe(false);
    expect(
      f.calls
        .filter((call) => call.method === "reactionCreate")
        .map((call) => call.input.content),
    ).toEqual(["eyes", "hooray"]);
    expect(
      f.calls.find((call) => call.method === "reactionDelete")?.input
        .reaction_id,
    ).toBe(60);
    expect(
      f.calls.filter((call) => call.method === "checkUpdate").at(-1)?.input
        .conclusion,
    ).toBe("success");
    expect(await readFile(process.env.GITHUB_STEP_SUMMARY, "utf8")).toContain(
      "Looks good to merge",
    );
  });
  it("never resolves an absent finding and does not trust cached fixed eligibility", async () => {
    const f = fixture();
    f.setThreads(false);
    await f.prepare();
    const cache = (await readReviewLifecycle())!;
    cache.eligibleFixedIds = ["f-known"];
    await saveReviewLifecycle(cache);
    await f.post([]);
    expect(f.calls.some((call) => call.method === "reply")).toBe(false);
    expect(decodeReviewState(f.body())?.findings[0]?.state).toBe("open");
    expect(
      f.calls.filter((call) => call.method === "checkUpdate").at(-1)?.input
        .conclusion,
    ).toBe("neutral");
  });
  it("resolves only an explicit fixed decision grounded in authenticated changed code", async () => {
    const f = fixture();
    f.setThreads(false);
    await f.prepare();
    await f.post(
      [],
      [
        {
          id: "f-known",
          status: "fixed",
          evidence: "The new timeout guard handles every request.",
        },
      ],
    );
    expect(
      f.calls.find((call) => call.method === "reply")?.input,
    ).toMatchObject({ comment_id: 81, body: "✅ Fixed in aaaaaaa." });
    expect(
      f.calls
        .filter((call) => call.method === "graphql")
        .some((call) => call.input.query.includes("DroidResolveThread")),
    ).toBe(true);
    expect(decodeReviewState(f.body())?.findings[0]?.state).toBe("resolved");
  });
  it("treats a trusted human-resolved thread as authoritative without cached state", async () => {
    const f = fixture([]);
    f.setThreads(true);
    await f.prepare();
    await f.post([{ status: "approved", comment: finding() }]);
    expect(f.calls.some((call) => call.method === "createReview")).toBe(false);
    expect(decodeReviewState(f.body())?.findings[0]?.state).toBe("dismissed");
  });
  it("rejects model-cached cross-PR targets before metadata mutations", async () => {
    const f = fixture();
    await f.prepare();
    const cache = (await readReviewLifecycle())!;
    cache.prNumber = 999;
    await saveReviewLifecycle(cache);
    f.calls.length = 0;
    await expect(lifecyclePhase({ octokit: f.octokit })).rejects.toThrow(
      "disagrees",
    );
    expect(f.calls).toEqual([]);
  });
  it("drops a planted clean disposition and false completed flag at the real finalizer entrypoint", async () => {
    const f = fixture();
    await f.prepare();
    const cache = (await readReviewLifecycle())!;
    cache.renderInput = { state: "clean", findings: [] };
    cache.completed = true;
    await saveReviewLifecycle(cache);
    process.env.REVIEW_PHASE = "finalize";
    process.env.DROID_SUCCESS = "true";
    await lifecyclePhase({ octokit: f.octokit });
    expect(
      f.calls.filter((call) => call.method === "checkUpdate").at(-1)?.input,
    ).toMatchObject({
      conclusion: "neutral",
      output: { title: "Review failed" },
    });
    expect(f.body()).toContain("couldn't finish");
    expect(
      f.calls.filter((call) => call.method === "reactionCreate").at(-1)?.input
        .content,
    ).toBe("confused");
  });
  it("does not let marker-shaped human thread roots authorize resolution", async () => {
    const f = fixture();
    f.setThreads(false, 99);
    expect(
      await listDroidThreads({
        octokit: f.octokit,
        owner: "o",
        repo: "r",
        prNumber: 7,
      }),
    ).toEqual([]);
  });
  it("binds optional CODEOWNERS metadata to the immutable base and never assigns", async () => {
    process.env.REVIEW_SUGGEST_REVIEWERS = "true";
    process.env.REVIEW_EFFORT = "true";
    process.env.REVIEW_PRE_MERGE_CHECKS = "title,description,linked_issue";
    const f = fixture([]);
    await f.prepare();
    await f.post([]);
    expect(
      f.calls.find((call) => call.method === "getContent")?.input,
    ).toMatchObject({ path: ".github/CODEOWNERS", ref: BASE });
    expect(f.body()).toContain("alice");
    expect(f.body()).toContain("Linked issue");
  });
  it("preserves author text and fenced examples in description mode", async () => {
    const author =
      "Author text\n\n```md\n<!-- droid-review-summary:start -->\nexample\n<!-- droid-review-summary:end -->\n```\n";
    const first = replaceReviewDescription(author, "First review");
    const second = replaceReviewDescription(first, "Second review");
    expect(second.startsWith(author)).toBe(true);
    expect(second).not.toContain("First review");
    expect(second).toContain("Second review");
    expect(() =>
      replaceReviewDescription("<!-- droid-review-summary:end -->", "x"),
    ).toThrow("ambiguous");
  });
  it("honors summary off without issue-comment writes and retains fallback in the step summary", async () => {
    process.env.REVIEW_SUMMARY = "off";
    process.env.GITHUB_STEP_SUMMARY = join(directory, "summary.md");
    const f = fixture([]);
    await f.prepare();
    await f.post([
      {
        status: "approved",
        comment: finding({ outside_diff: true, line: null }),
      },
    ]);
    expect(
      f.calls.some(
        (call) =>
          call.method === "updateComment" ||
          call.method === "createComment" ||
          call.method === "createReview",
      ),
    ).toBe(false);
    expect(await readFile(process.env.GITHUB_STEP_SUMMARY, "utf8")).toContain(
      "Outside the diff",
    );
  });
  it("warns once when all optional writes lack permission", async () => {
    const f = fixture();
    const denied = Object.assign(
      new Error("Resource not accessible by integration"),
      { status: 403 },
    );
    spyOn(f.octokit.rest.checks, "create").mockRejectedValue(denied);
    spyOn(f.octokit.rest.reactions, "createForIssue").mockRejectedValue(denied);
    spyOn(f.octokit.rest.issues, "updateComment").mockRejectedValue(denied);
    const prepared = await f.prepare();
    await finishReviewLifecycle({
      octokit: f.octokit,
      run: prepared.run,
      input: { state: "clean" },
    });
    expect(core.warning).toHaveBeenCalledTimes(1);
  });
  it("preserves only trusted incremental markers when the model updates visible progress", () => {
    const state = { head: OLD, findings: [] };
    const current = `${SUMMARY_MARKER}\n${encodeReviewState(state)}\n<!-- droid-review-active:v1 head=${HEAD} run=123 -->`;
    const result = prepareDroidTrackingCommentBody(
      `${encodeReviewState({ head: HEAD, findings: [] })}\nNew progress`,
      current,
    );
    expect(decodeReviewState(result)?.head).toBe(OLD);
    expect(result).toContain(`head=${HEAD} run=123`);
    expect(result).toContain("New progress");
  });
  it("does not accept missing immutable bindings", () => {
    expect(() => authoritativeReviewTarget({})).toThrow(
      "Immutable review target",
    );
  });
  it("does not match login substrings or human-planted summary markers, including earlier pages", async () => {
    const f = fixture([]);
    const unrelated = Array.from({ length: 100 }, (_, id) => ({
      id: id + 100,
      body: SUMMARY_MARKER,
      user: { id: 99, login: "not-droid[bot]" },
    }));
    spyOn(f.octokit.rest.issues, "listComments").mockImplementation((async (
      input: any,
    ) => ({
      data:
        input.page === 1
          ? unrelated
          : [{ id: 40, body: SUMMARY_MARKER, user: { id: 138933559 } }],
    })) as typeof f.octokit.rest.issues.listComments);
    const found = await findReviewSummary({
      octokit: f.octokit,
      owner: "o",
      repo: "r",
      prNumber: 7,
    });
    expect(found?.id).toBe(40);
  });
  it("rejects an immutable check id whose actual check belongs to a different head", async () => {
    const f = fixture([]);
    await f.prepare();
    spyOn(f.octokit.rest.checks, "get").mockResolvedValue({
      data: {
        id: 50,
        name: "Droid Review",
        head_sha: OLD,
        status: "in_progress",
      },
    } as any);
    await expect(loadBoundReviewLifecycle(f.octokit)).rejects.toThrow(
      "does not belong",
    );
  });
});

describe("incremental and check policy invariants", () => {
  it("incremental safety: restores LEFT findings only with explicit evidence on the changed file", () => {
    const left = finding({ side: "LEFT", line: 8 });
    const restored =
      "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -7,0 +8 @@\n+guard();\n";
    expect(changedFindingCandidates([left], restored)).toHaveLength(1);
    expect(changedFindingCandidates([finding({ line: 8 })], restored)).toEqual(
      [],
    );
    expect(
      changedFindingCandidates(
        [finding({ side: "LEFT", path: "other.ts", line: 8 })],
        restored,
      ),
    ).toEqual([]);
    expect(
      changedFindingCandidates([{ ...left, state: "dismissed" }], restored),
    ).toEqual([]);
    const options = {
      previous: [left],
      current: [],
      eligibleFixedIds: [left.id],
      head: HEAD,
    };
    expect(reconcileFindings(options).findings[0]?.state).not.toBe("resolved");
    expect(
      reconcileFindings({ ...options, fixedIds: [left.id] }).findings[0]?.state,
    ).toBe("resolved");
  });
  it("keeps fresh severity and security metadata without reposting old ids", () => {
    const prior = finding({ severity: "P2" });
    const current = finding({
      severity: "P0",
      security: true,
      securitySeverity: "critical",
    });
    const result = reconcileFindings({
      previous: [prior],
      current: [current],
      head: HEAD,
    });
    expect(result.newFindings).toEqual([]);
    expect(result.findings[0]?.securitySeverity).toBe("critical");
    expect(reviewCheckConclusion(result.findings)).toBe("failure");
  });
  it("suppresses only explicit non-security optional suggestions on unchanged code", () => {
    const suggestions = [
      finding({ id: "optional", severity: "P2", optionalSuggestion: true }),
      finding({
        id: "security",
        severity: "P2",
        security: true,
        optionalSuggestion: true,
      }),
      finding({ id: "correctness", severity: "P2" }),
    ];
    const result = reconcileFindings({
      previous: [],
      current: suggestions,
      incremental: true,
      changedPaths: new Set(),
      head: HEAD,
    });
    expect(result.unchangedSuggestions).toBe(1);
    expect(result.newFindings.map((f) => f.id)).toEqual([
      "security",
      "correctness",
    ]);
  });
  it("uses removed old-side lines, not hunk context, and decodes quoted Git paths", () => {
    expect(changedFindingCandidates([finding({ line: 2 })], DIFF)).toEqual([]);
    const quoted =
      'diff --git "a/a\\tb.ts" "b/a\\tb.ts"\n--- "a/a\\tb.ts"\n+++ "b/a\\tb.ts"\n@@ -1 +1 @@\n-a\n+b\n';
    expect(
      changedFindingCandidates([finding({ path: "a\tb.ts", line: 1 })], quoted),
    ).toHaveLength(1);
  });
  it("does not treat removed SQL comments inside a hunk as file headers", () => {
    const sqlDiff =
      "diff --git a/query.sql b/query.sql\n--- a/query.sql\n+++ b/query.sql\n@@ -1,2 +1,2 @@\n--- unsafe comment\n-SELECT unsafe_value;\n+-- safe comment\n+SELECT safe_value;\n";
    expect(
      changedFindingCandidates(
        [finding({ path: "query.sql", line: 2 })],
        sqlDiff,
      ),
    ).toHaveLength(1);
  });
  it("does not infer security taxonomy from P priority and only blocks configured levels", () => {
    expect(
      reviewCheckConclusion([finding({ severity: "P0", security: true })]),
    ).toBe("neutral");
    expect(
      reviewCheckConclusion([finding({ severity: "P2" })], {
        failOnSeverity: "P1",
      }),
    ).toBe("neutral");
    expect(
      reviewCheckConclusion([finding({ severity: "P1" })], {
        failOnSeverity: "P1",
      }),
    ).toBe("failure");
    expect(reviewCheckConclusion([], {}, true)).toBe("neutral");
  });
  it("handles first/full/identical/pause/automatic-budget plans", () => {
    expect(planIncrementalReview({ head: HEAD })).toEqual({});
    expect(planIncrementalReview({ state: { head: OLD }, head: HEAD })).toEqual(
      { incrementalBaseSha: OLD },
    );
    expect(
      planIncrementalReview({ state: { head: HEAD }, head: HEAD, full: true }),
    ).toEqual({});
    expect(
      planIncrementalReview({ state: { head: HEAD }, head: HEAD }).skipReason,
    ).toContain("No new changes");
    expect(
      planIncrementalReview({
        state: { head: OLD, paused: true },
        head: HEAD,
        automatic: true,
      }).skipReason,
    ).toContain("paused");
    expect(
      planIncrementalReview({
        state: { head: OLD, autoRunCount: 2 },
        maxAutoRuns: 2,
        head: HEAD,
        automatic: true,
      }).skipReason,
    ).toContain("limit");
  });
  it("does not skip a requested full review when the full diff hash is unchanged", () => {
    const input = {
      hash: "same-hash",
      previousHash: "same-hash",
      previousHead: OLD,
      incrementalUsed: false,
      empty: false,
    };
    expect(identicalReviewDiffSkipReason(input)).toBe(
      "No new changes since bbbbbbb",
    );
    expect(
      identicalReviewDiffSkipReason({ ...input, full: true }),
    ).toBeUndefined();
  });
  it("redacts retry diagnostics without changing the thrown error or retry policy", async () => {
    const error = Object.assign(new Error(`Denied fk-${"x".repeat(32)}`), {
      status: 403,
    });
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        retryWithBackoff(
          async () => {
            throw error;
          },
          { maxAttempts: 1 },
        ),
      ).rejects.toBe(error);
      expect(log.mock.calls.flat().join(" ")).not.toContain("fk-");
    } finally {
      log.mockRestore();
    }
  });
});
