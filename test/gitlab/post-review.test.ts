import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  buildDiffIndex,
  fallbackNoteBody,
  InvalidValidatedReviewError,
  parseValidatedReview,
  postReview,
  run as postReviewRun,
  type ReviewComment,
} from "../../src/entrypoints/gitlab-post-review";
import type { GitlabClient } from "../../src/gitlab/api/client";
import type { GitlabMrDiff } from "../../src/gitlab/types";

const DIFF_REFS = {
  base_sha: "base-sha",
  head_sha: "head-sha",
  start_sha: "start-sha",
};

const mrDiff = (overrides: Partial<GitlabMrDiff>): GitlabMrDiff => ({
  old_path: "src/x.ts",
  new_path: "src/x.ts",
  a_mode: "100644",
  b_mode: "100644",
  diff: "",
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  ...overrides,
});

// @@ -8,5 +8,5 @@ over src/x.ts:
//   new 8/9 context (old 8/9), new 10 added, new 11 context (old 10),
//   old 11 removed, new 12 context (old 12).
const X_TS_DIFF = "@@ -8,5 +8,5 @@\n a\n b\n+c\n d\n-e\n f\n";

const SAMPLE_CHANGES: GitlabMrDiff[] = [mrDiff({ diff: X_TS_DIFF })];

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

describe("buildDiffIndex", () => {
  it("classifies added, removed, and context lines with pairing", () => {
    const index = buildDiffIndex(SAMPLE_CHANGES).get("src/x.ts")!;

    expect(index.newLines.get(10)).toBe("added");
    expect(index.newLines.get(9)).toBe(9);
    expect(index.newLines.get(11)).toBe(10);
    expect(index.newLines.get(13)).toBeUndefined();
    expect(index.oldLines.get(11)).toBe("removed");
    expect(index.oldLines.get(12)).toBe(12);
  });

  it("registers a rename under both paths and skips meta lines", () => {
    const index = buildDiffIndex([
      mrDiff({
        old_path: "old.ts",
        new_path: "new.ts",
        renamed_file: true,
        diff: "@@ -1,2 +1,2 @@\n-a\n+b\n c\n\\ No newline at end of file\n",
      }),
    ]);

    expect(index.get("new.ts")).toBe(index.get("old.ts")!);
    expect(index.get("new.ts")!.newLines.get(1)).toBe("added");
    expect(index.get("new.ts")!.newLines.get(2)).toBe(2);
    // The "\ No newline" marker must not advance either counter.
    expect(index.get("new.ts")!.newLines.get(3)).toBeUndefined();
  });
});

describe("postReview", () => {
  let client: GitlabClient;
  let discussions: ReturnType<typeof mock>;
  let notes: ReturnType<typeof mock>;

  /** Discussion positions the client was asked to create, in order. */
  const positions = () =>
    (discussions.mock.calls as unknown[][]).map((c) => c[3] as any);

  /** Bodies of the plain-note fallbacks, in order. */
  const noteBodies = () =>
    (notes.mock.calls as unknown[][]).map((c) => c[2] as string);

  const post = (comments: ReviewComment[]) =>
    postReview({ client, projectId: "4242", mrIid: 7, comments });

  function setup(
    createDiscussion: (position: any) => unknown = () => ({ id: "disc" }),
    diffRefs: unknown = DIFF_REFS,
    opts: {
      changes?: GitlabMrDiff[];
      createNote?: () => unknown;
    } = {},
  ) {
    discussions = mock(async (...args: unknown[]) => createDiscussion(args[3]));
    notes = mock(async () => (opts.createNote ?? (() => ({ id: 1 })))());
    client = {
      getMr: mock(async () => ({ iid: 7, diff_refs: diffRefs })),
      getMrChanges: mock(async () => {
        // Without explicit changes the index is unavailable, exercising the
        // legacy anchor-as-given path.
        if (!opts.changes) throw new Error("changes unavailable");
        return { changes: opts.changes, diff_refs: DIFF_REFS };
      }),
      createDiscussionOnDiff: discussions,
      createNote: notes,
    } as unknown as GitlabClient;
  }

  beforeEach(() => setup());

  it("anchors RIGHT-side comments on new_line, mirroring old_path", async () => {
    const result = await post([
      comment({ line: 12 }),
      comment({ path: "new.ts", old_path: "old.ts" }),
    ]);

    expect(result).toEqual({ posted: 2, fallbackPosted: 0, failures: [] });
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

    expect(result).toEqual({ posted: 1, fallbackPosted: 0, failures: [] });
    expect(positions()).toHaveLength(2);
    expect(positions()[1].line_range).toBeUndefined();
  });

  it("posts a comment GitLab refuses as a plain note instead", async () => {
    setup((position) => {
      if (position.new_path === "gone.ts") throw new Error("400: not in diff");
      return { id: "disc" };
    });

    const result = await post([
      comment({ path: "gone.ts", line: 3 }),
      comment(),
    ]);

    expect(result).toEqual({ posted: 1, fallbackPosted: 1, failures: [] });
    expect(noteBodies()).toHaveLength(1);
    expect(noteBodies()[0]).toContain("gone.ts:3");
    expect(noteBodies()[0]).toContain("[P1] Finding");
  });

  it("records a failure when the note fallback also fails", async () => {
    setup(
      () => {
        throw new Error("400: not in diff");
      },
      DIFF_REFS,
      {
        createNote: () => {
          throw new Error("401: token revoked");
        },
      },
    );

    const result = await post([comment({ path: "gone.ts", line: 3 })]);

    expect(result.posted).toBe(0);
    expect(result.fallbackPosted).toBe(0);
    expect(result.failures).toEqual([
      {
        path: "gone.ts",
        line: 3,
        error: "400: not in diff; note fallback failed: 401: token revoked",
      },
    ]);
  });

  it("sends both line numbers for a context-line anchor", async () => {
    setup(undefined, DIFF_REFS, { changes: SAMPLE_CHANGES });

    // new 11 is an unchanged line pairing with old 10; GitLab requires both.
    await post([comment({ line: 11 })]);

    expect(positions()[0]).toMatchObject({ new_line: 11, old_line: 10 });
  });

  it("keeps an added-line anchor one-sided, dropping a stray old_line", async () => {
    setup(undefined, DIFF_REFS, { changes: SAMPLE_CHANGES });

    await post([comment({ line: 10, old_line: 3 })]);

    expect(positions()[0]).toMatchObject({ new_line: 10 });
    expect(positions()[0].old_line).toBeUndefined();
  });

  it("anchors LEFT comments per the index (removed vs context)", async () => {
    setup(undefined, DIFF_REFS, { changes: SAMPLE_CHANGES });

    await post([
      comment({ side: "LEFT", line: null, old_line: 11 }),
      comment({ side: "LEFT", line: null, old_line: 12 }),
    ]);

    expect(positions()[0]).toMatchObject({ old_line: 11 });
    expect(positions()[0].new_line).toBeUndefined();
    expect(positions()[1]).toMatchObject({ old_line: 12, new_line: 12 });
  });

  it("skips the API and posts a note for a line outside the diff", async () => {
    setup(undefined, DIFF_REFS, { changes: SAMPLE_CHANGES });

    const result = await post([comment({ line: 99 })]);

    expect(result).toEqual({ posted: 0, fallbackPosted: 1, failures: [] });
    // Unanchorable lines never reach the discussions endpoint.
    expect(positions()).toHaveLength(0);
    expect(noteBodies()[0]).toContain("src/x.ts:99");
  });

  it("fails when the MR carries no diff refs to anchor against", async () => {
    setup(undefined, null);
    await expect(post([comment()])).rejects.toThrow(/missing diff_refs/);
  });
});

describe("fallbackNoteBody", () => {
  const base: ReviewComment = {
    path: "src/new.ts",
    body: "finding",
    line: 12,
    startLine: null,
    side: "RIGHT",
    old_path: "src/old.ts",
    old_line: null,
  };

  it("references the old path for LEFT-side comments", () => {
    const body = fallbackNoteBody({ ...base, side: "LEFT" }, 12);
    expect(body).toContain("src/old.ts:12");
    expect(body).not.toContain("src/new.ts");
  });

  it("uses wording that also covers API refusals, not just out-of-diff lines", () => {
    const body = fallbackNoteBody(base, 12);
    expect(body).toContain("src/new.ts:12");
    expect(body).toContain("could not be posted inline");
    expect(body).not.toContain("outside the MR diff");
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

  it("skips approved comments with fractional lines or unknown sides", () => {
    const parsed = parseValidatedReview(
      validated([
        {
          status: "approved",
          comment: { path: "fraction.ts", body: "bad", line: 3.5 },
        },
        {
          status: "approved",
          comment: {
            path: "side.ts",
            body: "bad",
            line: 4,
            side: "MIDDLE",
          },
        },
      ]),
    );

    expect(parsed.approved).toHaveLength(0);
    expect(parsed.skipped.map((skip) => skip.reason)).toEqual([
      "no usable line anchor (side=RIGHT)",
      "approved comment has an invalid `side`",
    ]);
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

  /**
   * Answers the MR lookup and changes fetch; each discussion POST goes
   * through `onDiscussion`, each plain-note POST through `onNote`.
   */
  function stubFetch(
    onDiscussion: (call: FetchCall) => Response,
    onNote: (call: FetchCall) => Response = () =>
      new Response(JSON.stringify({ id: 1 })),
  ) {
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const call: FetchCall = {
        url: String(input),
        body: init.body ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      const ok = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status });
      if (call.url.includes("/discussions")) return onDiscussion(call);
      if (call.url.endsWith("/changes")) {
        return ok({ changes: SAMPLE_CHANGES, diff_refs: DIFF_REFS });
      }
      if (call.url.endsWith("/notes")) return onNote(call);
      return ok({ iid: 7, diff_refs: DIFF_REFS });
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
        // src/x.ts:10 is an added line in SAMPLE_CHANGES; gone.ts is not in
        // the diff at all, so it must degrade to a plain note.
        approved(),
        approved({ path: "gone.ts", line: 99 }),
        { status: "rejected", comment: { path: "z.ts", body: "no", line: 1 } },
      ],
      { body: "## Review summary" },
    );
    stubFetch(posted);

    await postReviewRun();

    const discussions = calls.filter((c) => c.url.includes("/discussions"));
    expect(discussions).toHaveLength(1);
    expect(discussions[0]!.url).toContain(
      "/projects/4242/merge_requests/7/discussions",
    );
    expect(discussions[0]!.body.body).toBe("[P1] Finding");
    // The only plain note is the out-of-diff fallback; the summary still
    // belongs to the tracking note, never a second MR note.
    const notes = calls.filter((c) => c.url.endsWith("/notes"));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body.body).toContain("gone.ts:99");
    expect(notes[0]!.body.body).not.toContain("## Review summary");

    expect(await readPostResults()).toEqual({
      posted: 1,
      fallbackPosted: 1,
      approved: 2,
      rejected: 1,
      failed: 0,
      skipped: 0,
      summaryBody: "## Review summary",
      failures: [],
    });
  });

  it("fails when every approved comment is rejected by the API", async () => {
    await writeState();
    await writeValidated([approved()]);
    // Both the positioned discussion and the note fallback are refused.
    stubFetch(refused, refused);

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
