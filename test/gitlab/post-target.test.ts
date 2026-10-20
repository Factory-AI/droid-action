import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  PostTargetMismatchError,
  resolveOwnTrackingNoteId,
  resolvePostTarget,
} from "../../src/gitlab/operations/post-target";
import { DROID_TRACKING_MARKER } from "../../src/gitlab/operations/tracking-note";
import { GitlabClient } from "../../src/gitlab/api/client";
import { run as updateCommentLinkRun } from "../../src/entrypoints/gitlab-update-comment-link";

const BOT = { id: 99, username: "droid-bot" };
const HUMAN = { id: 5, username: "mr-author" };

describe("resolvePostTarget", () => {
  const env = { CI_PROJECT_ID: "4242", CI_MERGE_REQUEST_IID: "7" };

  it("takes the project and MR from the CI variables", () => {
    expect(resolvePostTarget({ projectId: "4242", mrIid: 7 }, env)).toEqual({
      projectId: "4242",
      mrIid: 7,
    });
    expect(resolvePostTarget({}, env)).toEqual({
      projectId: "4242",
      mrIid: 7,
    });
  });

  it("refuses a state file that names another project or MR", () => {
    expect(() => resolvePostTarget({ projectId: "1", mrIid: 7 }, env)).toThrow(
      PostTargetMismatchError,
    );
    expect(() =>
      resolvePostTarget({ projectId: "4242", mrIid: 8 }, env),
    ).toThrow(PostTargetMismatchError);
  });

  it("refuses to run without the CI variables", () => {
    expect(() =>
      resolvePostTarget({ projectId: "4242", mrIid: 7 }, {}),
    ).toThrow(/CI_PROJECT_ID/);
    expect(() =>
      resolvePostTarget(
        { projectId: "4242", mrIid: 7 },
        { CI_PROJECT_ID: "4242" },
      ),
    ).toThrow(/CI_MERGE_REQUEST_IID/);
    expect(() =>
      resolvePostTarget(
        {},
        { CI_PROJECT_ID: "4242", CI_MERGE_REQUEST_IID: "7; rm" },
      ),
    ).toThrow(/CI_MERGE_REQUEST_IID/);
  });
});

type Call = { method: string; url: string; body: any };

/** A GitLab API stub holding the notes of MR !7 in project 4242. */
function stubGitlab(notes: Array<{ id: number; body: string; author: any }>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: String(input),
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const ok = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status });
    const url = new URL(call.url);
    if (url.pathname.endsWith("/user")) return ok(BOT);
    const prefix = "/api/v4/projects/4242/merge_requests/7/notes";
    if (!url.pathname.startsWith(prefix)) {
      return ok({ message: "404 Not found" }, 404);
    }
    const rest = url.pathname.slice(prefix.length);
    if (rest === "" && call.method === "GET") return ok(notes);
    if (rest === "" && call.method === "POST") return ok({ id: 500 });
    const note = notes.find((n) => `/${n.id}` === rest);
    if (!note) return ok({ message: "404 Not found" }, 404);
    return ok(note);
  }) as typeof fetch;
  return calls;
}

describe("resolveOwnTrackingNoteId", () => {
  const originalFetch = globalThis.fetch;
  const target = { projectId: "4242", mrIid: 7 };
  const client = () =>
    new GitlabClient("glpat-test", "https://gitlab.example.com/api/v4");

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("accepts the hinted note when the token's user wrote it with the marker", async () => {
    stubGitlab([{ id: 11, body: `${DROID_TRACKING_MARKER}\nx`, author: BOT }]);
    expect(await resolveOwnTrackingNoteId(client(), target, 11)).toBe(11);
  });

  it("rejects a hinted note by someone else and falls back to the bot's own", async () => {
    stubGitlab([
      { id: 11, body: `${DROID_TRACKING_MARKER}\nfake`, author: HUMAN },
      { id: 12, body: `${DROID_TRACKING_MARKER}\nreal`, author: BOT },
    ]);
    expect(await resolveOwnTrackingNoteId(client(), target, 11)).toBe(12);
  });

  it("rejects a hinted note without the marker", async () => {
    stubGitlab([{ id: 11, body: "a regular bot comment", author: BOT }]);
    expect(await resolveOwnTrackingNoteId(client(), target, 11)).toBeNull();
  });

  it("rejects a hinted note that is not on this MR", async () => {
    stubGitlab([]);
    expect(await resolveOwnTrackingNoteId(client(), target, 999)).toBeNull();
  });
});

describe("gitlab-update-comment-link entrypoint", () => {
  const ENV_KEYS = [
    "GITLAB_TOKEN",
    "OVERRIDE_GITLAB_TOKEN",
    "FACTORY_API_KEY",
    "CI_API_V4_URL",
    "GITLAB_API_URL",
    "CI_PROJECT_ID",
    "CI_MERGE_REQUEST_IID",
    "DROID_STATE_FILE",
    "DROID_SUCCESS",
    "DROID_ERROR_FILE",
    "DROID_ERROR_DETAILS",
    "DROID_PASS1_LOG",
    "DROID_PASS2_LOG",
    "REVIEW_POST_RESULTS_PATH",
    "DROID_PROMPT_FILE",
  ] as const;
  const originalFetch = globalThis.fetch;
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;

  async function writeState(overrides: Record<string, unknown> = {}) {
    const statePath = path.join(tmpDir, ".droid-state.json");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        shouldRunReview: true,
        projectId: "4242",
        mrIid: 7,
        trackingNoteId: 11,
        ...overrides,
      }),
    );
    process.env.DROID_STATE_FILE = statePath;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "droid-update-link-"));
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.GITLAB_TOKEN = "glpat-test-token-value";
    process.env.CI_API_V4_URL = "https://gitlab.example.com/api/v4";
    process.env.CI_PROJECT_ID = "4242";
    process.env.CI_MERGE_REQUEST_IID = "7";
    process.env.DROID_ERROR_FILE = path.join(tmpDir, "droid-error.txt");
    process.env.DROID_PASS1_LOG = path.join(tmpDir, "pass1.jsonl");
    process.env.DROID_PASS2_LOG = path.join(tmpDir, "pass2.jsonl");
    process.env.REVIEW_POST_RESULTS_PATH = path.join(tmpDir, "results.json");
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

  it("updates the bot's own tracking note on the CI-provided MR", async () => {
    await writeState();
    const calls = stubGitlab([
      { id: 11, body: `${DROID_TRACKING_MARKER}\nrunning`, author: BOT },
    ]);

    await updateCommentLinkRun();

    const w = writes(calls);
    expect(w).toHaveLength(1);
    expect(w[0]!.method).toBe("PUT");
    expect(w[0]!.url).toBe(
      "https://gitlab.example.com/api/v4/projects/4242/merge_requests/7/notes/11",
    );
  });

  it("never edits a note the state file points at when someone else wrote it", async () => {
    await writeState({ trackingNoteId: 13 });
    const calls = stubGitlab([
      { id: 13, body: `${DROID_TRACKING_MARKER}\nhijack`, author: HUMAN },
    ]);

    await updateCommentLinkRun();

    const w = writes(calls);
    expect(w).toHaveLength(1);
    expect(w[0]!.method).toBe("POST");
    expect(w[0]!.url).toBe(
      "https://gitlab.example.com/api/v4/projects/4242/merge_requests/7/notes",
    );
  });

  it("refuses a state file that redirects the update to another MR", async () => {
    await writeState({ projectId: "1", mrIid: 1 });
    const calls = stubGitlab([]);

    await expect(updateCommentLinkRun()).rejects.toThrow(
      PostTargetMismatchError,
    );
    expect(calls).toHaveLength(0);
  });

  it("embeds the error file capped and redacted on failure", async () => {
    process.env.DROID_SUCCESS = "false";
    process.env.FACTORY_API_KEY = "factory-secret-value-123456";
    await fs.writeFile(
      process.env.DROID_ERROR_FILE!,
      `pass failed with factory-secret-value-123456\n${"x".repeat(10_000)}`,
    );
    await writeState();
    const calls = stubGitlab([
      { id: 11, body: `${DROID_TRACKING_MARKER}\nrunning`, author: BOT },
    ]);

    await updateCommentLinkRun();

    const body: string = writes(calls)[0]!.body.body;
    expect(body).toContain("pass failed with [REDACTED]");
    expect(body).not.toContain("factory-secret-value-123456");
    expect(body).toContain("(truncated)");
    expect(body.length).toBeLessThan(6000);
  });

  it("does not follow an error file that is a symlink", async () => {
    process.env.DROID_SUCCESS = "false";
    const target = path.join(tmpDir, "secret.txt");
    await fs.writeFile(target, "SECRET_CONTENTS_FROM_ANOTHER_FILE");
    await fs.symlink(target, process.env.DROID_ERROR_FILE!);
    await writeState();
    const calls = stubGitlab([
      { id: 11, body: `${DROID_TRACKING_MARKER}\nrunning`, author: BOT },
    ]);

    await updateCommentLinkRun();

    const body: string = writes(calls)[0]!.body.body;
    expect(body).not.toContain("SECRET_CONTENTS_FROM_ANOTHER_FILE");
    expect(body).not.toContain("Error details");
  });
});
