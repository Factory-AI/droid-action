import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { run as postReviewRun } from "../../src/entrypoints/gitlab-post-review";

type FetchCall = { url: string; method: string; body: unknown };

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
const originalFetch = globalThis.fetch;
let calls: FetchCall[];

function stubFetch(handler: (call: FetchCall) => Response) {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const call: FetchCall = {
      url: typeof input === "string" ? input : String(input),
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function writeState(overrides: Record<string, unknown> = {}) {
  const statePath = path.join(tmpDir, ".droid-state.json");
  await fs.writeFile(
    statePath,
    JSON.stringify({
      shouldRunReview: true,
      projectId: "4242",
      projectPath: "group/project",
      mrIid: 7,
      trackingNoteId: 555,
      validatedPath: path.join(tmpDir, "review_validated.json"),
      ...overrides,
    }),
  );
  process.env.DROID_STATE_FILE = statePath;
  return statePath;
}

async function writeValidated(results: unknown[], reviewSummary?: unknown) {
  const validatedPath = path.join(tmpDir, "review_validated.json");
  await fs.writeFile(
    validatedPath,
    JSON.stringify({
      version: 1,
      meta: { project: "group/project", mrIid: 7 },
      results,
      ...(reviewSummary === undefined ? {} : { reviewSummary }),
    }),
  );
  return validatedPath;
}

async function readPostResults() {
  const raw = await fs.readFile(
    path.join(tmpDir, "review_post_results.json"),
    "utf8",
  );
  return JSON.parse(raw);
}

const approved = (overrides: Record<string, unknown> = {}) => ({
  status: "approved",
  comment: {
    path: "src/x.ts",
    body: "[P1] Finding",
    line: 10,
    startLine: null,
    side: "RIGHT",
    ...overrides,
  },
});

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

describe("gitlab-post-review entrypoint", () => {
  it("posts each approved comment as an inline discussion", async () => {
    await writeState();
    await writeValidated(
      [
        approved({ path: "a.ts", line: 3 }),
        { status: "rejected", candidate: { path: "b.ts" }, reason: "noise" },
        approved({ path: "c.ts", line: 8 }),
      ],
      { body: "Two real issues." },
    );

    stubFetch((call) => {
      if (call.url.includes("/merge_requests/7") && call.method === "GET") {
        return json({
          iid: 7,
          diff_refs: {
            base_sha: "base",
            head_sha: "head",
            start_sha: "start",
          },
        });
      }
      return json({ id: "disc" }, 201);
    });

    await postReviewRun();

    const discussions = calls.filter((c) => c.url.includes("/discussions"));
    expect(discussions).toHaveLength(2);
    expect(discussions[0]!.url).toContain(
      "https://gitlab.example.com/api/v4/projects/4242/merge_requests/7/discussions",
    );
    expect(discussions[0]!.body).toMatchObject({
      body: "[P1] Finding",
      position: {
        base_sha: "base",
        head_sha: "head",
        start_sha: "start",
        position_type: "text",
        new_path: "a.ts",
        new_line: 3,
      },
    });

    // Nothing else on the MR is touched: no notes, no description edits.
    expect(calls.some((c) => c.url.includes("/notes"))).toBe(false);

    const results = await readPostResults();
    expect(results).toMatchObject({
      posted: 2,
      approved: 2,
      rejected: 1,
      failed: 0,
      skipped: 0,
      summaryBody: "Two real issues.",
    });
  });

  it("succeeds with nothing posted when every candidate was rejected", async () => {
    await writeState();
    await writeValidated([
      { status: "rejected", candidate: { path: "a.ts" }, reason: "not a bug" },
    ]);
    stubFetch(() => json({}, 200));

    await postReviewRun();

    expect(calls).toHaveLength(0);
    expect(await readPostResults()).toMatchObject({
      posted: 0,
      approved: 0,
      rejected: 1,
    });
  });

  it("keeps going when one comment cannot be anchored", async () => {
    await writeState();
    await writeValidated([
      approved({ path: "a.ts", line: 3 }),
      approved({ path: "gone.ts", line: 900 }),
    ]);

    stubFetch((call) => {
      if (call.method === "GET") {
        return json({
          iid: 7,
          diff_refs: { base_sha: "b", head_sha: "h", start_sha: "s" },
        });
      }
      const position = (call.body as any)?.position;
      if (position?.new_path === "gone.ts") {
        return json({ message: "line_code must be a valid line code" }, 400);
      }
      return json({ id: "disc" }, 201);
    });

    await postReviewRun();

    const results = await readPostResults();
    expect(results.posted).toBe(1);
    expect(results.failed).toBe(1);
    expect(results.failures[0]).toMatchObject({ path: "gone.ts", line: 900 });
    expect(results.failures[0].error).toContain("400");
  });

  it("fails the job when every approved comment is refused", async () => {
    await writeState();
    await writeValidated([approved({ line: 900 })]);

    stubFetch((call) => {
      if (call.method === "GET") {
        return json({
          iid: 7,
          diff_refs: { base_sha: "b", head_sha: "h", start_sha: "s" },
        });
      }
      return json({ message: "403 Forbidden" }, 403);
    });

    await expect(postReviewRun()).rejects.toThrow(
      "all 1 approved comments failed to post",
    );
  });

  it("fails when Pass 2 never wrote the validated file", async () => {
    await writeState();
    stubFetch(() => json({}, 200));

    await expect(postReviewRun()).rejects.toThrow("Pass 2 did not write");
    expect(calls).toHaveLength(0);
  });

  it("fails on a validated file that is not parseable", async () => {
    await writeState();
    await fs.writeFile(
      path.join(tmpDir, "review_validated.json"),
      "{ half a file",
    );
    stubFetch(() => json({}, 200));

    await expect(postReviewRun()).rejects.toThrow("not valid JSON");
  });

  it("does nothing when prepare decided not to review", async () => {
    await writeState({
      shouldRunReview: false,
      reason: "not-merge-request-event",
    });
    stubFetch(() => json({}, 200));

    await postReviewRun();
    expect(calls).toHaveLength(0);
  });

  it("no-ops when the validator prepare short-circuited Pass 2", async () => {
    // Pass 1 left no usable candidates file, so Pass 2 ran a no-op prompt and
    // never wrote review_validated.json. Failing here would turn that
    // deliberate soft landing into a red pipeline.
    await writeState({ validatorSkippedReason: "candidates JSON missing" });
    stubFetch(() => json({}, 200));

    await postReviewRun();

    expect(calls).toHaveLength(0);
    await expect(readPostResults()).rejects.toThrow();
  });

  it("fails loudly when there is no state file", async () => {
    process.env.DROID_STATE_FILE = path.join(tmpDir, "missing.json");
    stubFetch(() => json({}, 200));

    await expect(postReviewRun()).rejects.toThrow("no state file");
  });

  it("explains an unexpanded GITLAB_TOKEN instead of sending it and getting a 401", async () => {
    // `GITLAB_TOKEN: $GITLAB_TOKEN` in a job's variables block is a circular
    // reference GitLab cannot expand, so the job receives the literal string.
    await writeState();
    await writeValidated([approved()]);
    process.env.GITLAB_TOKEN = "$GITLAB_TOKEN";
    stubFetch(() => json({}, 200));

    await expect(postReviewRun()).rejects.toThrow(
      "passed through as the literal string",
    );
    expect(calls).toHaveLength(0);
  });

  it("counts approved comments it had to skip", async () => {
    await writeState();
    await writeValidated([
      approved({ path: "a.ts", line: 3 }),
      approved({ path: "b.ts", line: null }),
    ]);

    stubFetch((call) => {
      if (call.method === "GET") {
        return json({
          iid: 7,
          diff_refs: { base_sha: "b", head_sha: "h", start_sha: "s" },
        });
      }
      return json({ id: "disc" }, 201);
    });

    await postReviewRun();

    const results = await readPostResults();
    expect(results).toMatchObject({ posted: 1, approved: 2, skipped: 1 });
    expect(calls.filter((c) => c.url.includes("/discussions"))).toHaveLength(1);
  });

  it("reads the path prepare recorded, not a later REVIEW_VALIDATED_PATH", async () => {
    // The state path is the file Pass 2's prompt named, so it wins; the env
    // var only matters when an older state carries no path.
    await writeState();
    await writeValidated([approved({ path: "z.ts" })]);
    process.env.REVIEW_VALIDATED_PATH = path.join(tmpDir, "never-written.json");

    stubFetch((call) => {
      if (call.method === "GET") {
        return json({
          iid: 7,
          diff_refs: { base_sha: "b", head_sha: "h", start_sha: "s" },
        });
      }
      return json({ id: "disc" }, 201);
    });

    await postReviewRun();

    const discussions = calls.filter((c) => c.url.includes("/discussions"));
    expect((discussions[0]!.body as any).position.new_path).toBe("z.ts");
  });

  it("falls back to REVIEW_VALIDATED_PATH when the state has no path", async () => {
    await writeState({ validatedPath: null });
    const altPath = path.join(tmpDir, "elsewhere.json");
    await fs.writeFile(
      altPath,
      JSON.stringify({ version: 1, results: [approved({ path: "alt.ts" })] }),
    );
    process.env.REVIEW_VALIDATED_PATH = altPath;

    stubFetch((call) => {
      if (call.method === "GET") {
        return json({
          iid: 7,
          diff_refs: { base_sha: "b", head_sha: "h", start_sha: "s" },
        });
      }
      return json({ id: "disc" }, 201);
    });

    await postReviewRun();

    const discussions = calls.filter((c) => c.url.includes("/discussions"));
    expect((discussions[0]!.body as any).position.new_path).toBe("alt.ts");
  });
});
