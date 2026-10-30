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
} from "../../src/core/review/markers";
import {
  authoritativeReviewTarget,
  findReviewSummary,
  finishReviewLifecycle,
  loadBoundReviewLifecycle,
  prepareReviewLifecycle,
  readReviewLifecycle,
  replaceReviewDescription,
  saveReviewLifecycle,
} from "../../src/github/operations/review-lifecycle";
import { run as postReview } from "../../src/entrypoints/github-post-review-v2";
import { run as lifecyclePhase } from "../../src/entrypoints/github-review-lifecycle";
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
  });
  afterEach(async () => {
    mock.restore();
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(directory, { recursive: true, force: true });
  });
  function fixture(prior = [finding()]) {
    const calls: Array<{ method: string; input: any }> = [];
    const state = {
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
            return { data: { id: 50 } };
          },
          get: async (input: any) => {
            record("checkGet", input);
            return {
              data: {
                id: 50,
                name: "Droid Review",
                head_sha: HEAD,
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
    async function prepare() {
      const result = await prepareReviewLifecycle({
        octokit,
        context,
        headSha: HEAD,
        baseSha: BASE,
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
          meta: { headSha: HEAD },
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
    function setThreads(resolved: boolean, author = 138933559) {
      threads = [
        {
          id: "T81",
          isResolved: resolved,
          path: "src/x.ts",
          line: 1,
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
    expect(created.comments[0].body).toContain('alt="P1"');
    expect(created.comments[0].body).toContain("droid-finding:v1");
    expect(decodeReviewState(f.body())?.head).toBe(HEAD);
    expect(
      f.calls
        .filter((call) => call.method === "compare")
        .map((call) => call.input.basehead),
    ).toContain(`${BASE}...${HEAD}`);
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
    expect(f.body()).toContain("couldn't finish");
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
    spyOn(f.octokit.rest.issues, "updateComment").mockRejectedValue(denied);
    const prepared = await f.prepare();
    await finishReviewLifecycle({
      octokit: f.octokit,
      run: prepared.run,
      input: { state: "clean" },
    });
    expect(core.warning).toHaveBeenCalledTimes(1);
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
});

describe("GitHub v2 invariants", () => {
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
