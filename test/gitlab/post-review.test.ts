import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  InvalidValidatedReviewError,
  parseValidatedReview,
  postReview,
  run as postReviewRun,
  type ReviewComment,
} from "../../src/entrypoints/gitlab-post-review";
import type { GitlabClient } from "../../src/gitlab/api/client";

const DIFF_REFS = {
  base_sha: "base-sha",
  head_sha: "head-sha",
  start_sha: "start-sha",
};

const comment = (overrides: Partial<ReviewComment> = {}): ReviewComment => ({
  path: "src/x.ts",
  body: "[P1] Finding",
  line: 10,
  startLine: null,
  side: "RIGHT",
  old_path: null,
  old_line: null,
  ...overrides,
});

describe("postReview", () => {
  let client: GitlabClient;
  let discussions: ReturnType<typeof mock>;

  /** Discussion positions the client was asked to create, in order. */
  const positions = () =>
    (discussions.mock.calls as unknown[][]).map((c) => c[3] as any);

  const post = (comments: ReviewComment[]) =>
    postReview({ client, projectId: "4242", mrIid: 7, comments });

  function setup(
    createDiscussion: (position: any) => unknown = () => ({ id: "disc" }),
    diffRefs: unknown = DIFF_REFS,
  ) {
    discussions = mock(async (...args: unknown[]) => createDiscussion(args[3]));
    client = {
      getMr: mock(async () => ({ iid: 7, diff_refs: diffRefs })),
      createDiscussionOnDiff: discussions,
    } as unknown as GitlabClient;
  }

  beforeEach(() => setup());

  it("anchors RIGHT-side comments on new_line, mirroring old_path", async () => {
    const result = await post([
      comment({ line: 12 }),
      comment({ path: "new.ts", old_path: "old.ts" }),
    ]);

    expect(result).toEqual({ posted: 2, failures: [] });
    expect(positions()[0]).toEqual({
      ...DIFF_REFS,
      position_type: "text",
      new_path: "src/x.ts",
      old_path: "src/x.ts",
      new_line: 12,
    });
    // A rename keeps both sides of the path.
    expect(positions()[1]).toMatchObject({
      new_path: "new.ts",
      old_path: "old.ts",
    });
  });

  it("anchors LEFT-side comments on old_line, falling back to line", async () => {
    await post([
      comment({ side: "LEFT", line: 9, old_line: 4 }),
      comment({ side: "LEFT", line: 9 }),
    ]);

    expect(positions()[0]).toMatchObject({ old_line: 4 });
    expect(positions()[0].new_line).toBeUndefined();
    expect(positions()[1]).toMatchObject({ old_line: 9 });
  });

  it("sends a line_range for a multi-line span", async () => {
    await post([comment({ line: 20, startLine: 18 })]);

    const sha = createHash("sha1").update("src/x.ts").digest("hex");
    expect(positions()[0].line_range).toEqual({
      start: { line_code: `${sha}_0_18`, type: "new" },
      end: { line_code: `${sha}_0_20`, type: "new" },
    });
  });

  it("falls back to the single-line anchor when GitLab rejects the range", async () => {
    // Spans over unchanged context lines cannot be reconstructed from a
    // one-sided anchor; the finding should still land on its end line.
    setup((position) => {
      if (position.line_range) throw new Error("400: line_code is invalid");
      return { id: "disc" };
    });

    const result = await post([comment({ line: 20, startLine: 18 })]);

    expect(result).toEqual({ posted: 1, failures: [] });
    expect(positions()).toHaveLength(2);
    expect(positions()[1].line_range).toBeUndefined();
  });

  it("records a comment GitLab refuses and keeps posting the rest", async () => {
    setup((position) => {
      if (position.new_path === "gone.ts") throw new Error("400: not in diff");
      return { id: "disc" };
    });

    const result = await post([
      comment({ path: "gone.ts", line: 3 }),
      comment(),
    ]);

    expect(result.posted).toBe(1);
    expect(result.failures).toEqual([
      { path: "gone.ts", line: 3, error: "400: not in diff" },
    ]);
  });

  it("fails when the MR carries no diff refs to anchor against", async () => {
    setup(undefined, null);
    await expect(post([comment()])).rejects.toThrow(/missing diff_refs/);
  });
});

describe("parseValidatedReview", () => {
  const validated = (results: unknown[], reviewSummary?: unknown) =>
    JSON.stringify({
      version: 1,
      results,
      ...(reviewSummary ? { reviewSummary } : {}),
    });

  it("posts only approved entries and accounts for the rest", () => {
    const parsed = parseValidatedReview(
      validated([
        {
          status: "approved",
          comment: { path: "a.ts", body: "keep", line: 3.0 },
        },
        {
          status: "rejected",
          comment: { path: "b.ts", body: "drop", line: 4 },
        },
        { status: "maybe", comment: { path: "c.ts", body: "drop", line: 5 } },
        { status: "approved", comment: { path: "d.ts", body: "no anchor" } },
        { status: "approved" },
        "not an object",
      ]),
    );

    expect(parsed.approved).toEqual([
      {
        path: "a.ts",
        body: "keep",
        line: 3,
        startLine: null,
        side: "RIGHT",
        old_path: null,
        old_line: null,
      },
    ]);
    expect(parsed.approvedCount).toBe(3);
    // An unrecognized status is treated like a rejection, never posted.
    expect(parsed.rejectedCount).toBe(2);
    expect(parsed.skipped.map((s) => s.path)).toEqual(["d.ts", null, null]);
  });

  it("anchors LEFT entries on old_line and keeps only usable spans", () => {
    const parsed = parseValidatedReview(
      validated(
        [
          {
            status: "approved",
            comment: {
              path: "a.ts",
              body: "b",
              line: null,
              old_line: 11,
              side: "LEFT",
              startLine: 9,
            },
          },
          {
            status: "approved",
            comment: { path: "b.ts", body: "b", line: 4, startLine: 4 },
          },
        ],
        { body: "## Review summary" },
      ),
    );

    expect(parsed.approved[0]).toMatchObject({
      side: "LEFT",
      old_line: 11,
      startLine: 9,
    });
    // startLine at or past the anchor is not a span.
    expect(parsed.approved[1]).toMatchObject({ startLine: null });
    expect(parsed.summaryBody).toBe("## Review summary");
  });

  it("refuses input that is not a validated review", () => {
    expect(() => parseValidatedReview("not json")).toThrow(
      InvalidValidatedReviewError,
    );
    expect(() => parseValidatedReview("[]")).toThrow(/not an object/);
    // A candidates file has `comments`, not `results`.
    expect(() => parseValidatedReview('{"comments": []}')).toThrow(
      /missing `results` array/,
    );
  });
});

describe("gitlab-post-review entrypoint", () => {
  type FetchCall = { url: string; body: any };

  const ENV_KEYS = [
    "GITLAB_TOKEN",
    "OVERRIDE_GITLAB_TOKEN",
    "CI_API_V4_URL",
    "GITLAB_API_URL",
    "DROID_STATE_FILE",
    "REVIEW_VALIDATED_PATH",
    "REVIEW_POST_RESULTS_PATH",
    "DROID_PROMPT_FILE",
    "CI_PROJECT_DIR",
  ] as const;

  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;
  let calls: FetchCall[];
  const originalFetch = globalThis.fetch;

  /** Answers the MR lookup, and each discussion POST via `onDiscussion`. */
  function stubFetch(onDiscussion: (call: FetchCall) => Response) {
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const call: FetchCall = {
        url: String(input),
        body: init.body ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      const ok = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status });
      return call.url.includes("/discussions")
        ? onDiscussion(call)
        : ok({ iid: 7, diff_refs: DIFF_REFS });
    }) as typeof fetch;
  }

  const posted = () => new Response(JSON.stringify({ id: "disc" }));
  const refused = () =>
    new Response(JSON.stringify({ message: "not in diff" }), { status: 400 });

  async function writeState(overrides: Record<string, unknown> = {}) {
    const statePath = path.join(tmpDir, ".droid-state.json");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        shouldRunReview: true,
        projectId: "4242",
        mrIid: 7,
        validatedPath: path.join(tmpDir, "review_validated.json"),
        ...overrides,
      }),
    );
    process.env.DROID_STATE_FILE = statePath;
  }

  const approved = (overrides: Record<string, unknown> = {}) => ({
    status: "approved",
    comment: { path: "src/x.ts", body: "[P1] Finding", line: 10, ...overrides },
  });

  async function writeValidated(results: unknown[], reviewSummary?: unknown) {
    await fs.writeFile(
      path.join(tmpDir, "review_validated.json"),
      JSON.stringify({
        version: 1,
        results,
        ...(reviewSummary ? { reviewSummary } : {}),
      }),
    );
  }

  const readPostResults = async () =>
    JSON.parse(
      await fs.readFile(path.join(tmpDir, "review_post_results.json"), "utf8"),
    );

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "droid-post-review-"));
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.GITLAB_TOKEN = "test-token";
    process.env.CI_API_V4_URL = "https://gitlab.example.com/api/v4";
    process.env.REVIEW_POST_RESULTS_PATH = path.join(
      tmpDir,
      "review_post_results.json",
    );
    calls = [];
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("posts the approved comments and records what happened", async () => {
    await writeState();
    await writeValidated(
      [
        approved(),
        approved({ path: "gone.ts", line: 99 }),
        { status: "rejected", comment: { path: "z.ts", body: "no", line: 1 } },
      ],
      { body: "## Review summary" },
    );
    stubFetch((call) =>
      call.body.position.new_path === "gone.ts" ? refused() : posted(),
    );

    await postReviewRun();

    const discussions = calls.filter((c) => c.url.includes("/discussions"));
    expect(discussions[0]!.url).toContain(
      "/projects/4242/merge_requests/7/discussions",
    );
    expect(discussions[0]!.body.body).toBe("[P1] Finding");
    // The summary belongs to the tracking note, not a second MR note.
    expect(calls.some((c) => c.url.endsWith("/notes"))).toBe(false);

    expect(await readPostResults()).toEqual({
      posted: 1,
      approved: 2,
      rejected: 1,
      failed: 1,
      skipped: 0,
      summaryBody: "## Review summary",
      failures: [{ path: "gone.ts", line: 99, error: expect.any(String) }],
    });
  });

  it("fails when every approved comment is rejected by the API", async () => {
    await writeState();
    await writeValidated([approved()]);
    stubFetch(refused);

    await expect(postReviewRun()).rejects.toThrow(/all 1 approved comments/);
  });

  it("fails when Pass 2 wrote no validated file", async () => {
    await writeState();
    stubFetch(posted);

    await expect(postReviewRun()).rejects.toThrow(/did not write/);
    expect(calls).toHaveLength(0);
  });

  it("no-ops when prepare decided not to review", async () => {
    await writeState({ shouldRunReview: false, reason: "not an MR pipeline" });
    stubFetch(posted);

    await postReviewRun();

    expect(calls).toHaveLength(0);
  });

  it("no-ops when the validator step short-circuited Pass 2", async () => {
    // Pass 1 left no usable candidates, so Pass 2 ran a no-op prompt and
    // never wrote review_validated.json. Failing here would turn that
    // deliberate soft landing into a red pipeline.
    await writeState({ validatorSkippedReason: "candidates JSON missing" });
    stubFetch(posted);

    await postReviewRun();

    expect(calls).toHaveLength(0);
  });

  it("refuses an unexpanded $GITLAB_TOKEN before calling the API", async () => {
    // `variables: GITLAB_TOKEN: $GITLAB_TOKEN` is a circular reference that
    // GitLab hands to the job verbatim.
    process.env.GITLAB_TOKEN = "$GITLAB_TOKEN";
    await writeState();
    await writeValidated([approved()]);
    stubFetch(posted);

    await expect(postReviewRun()).rejects.toThrow(/unexpanded/i);
    expect(calls).toHaveLength(0);
  });
});
