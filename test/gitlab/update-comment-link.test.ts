import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { run } from "../../src/entrypoints/gitlab-update-comment-link";
import { DROID_TRACKING_MARKER } from "../../src/gitlab/operations/tracking-note";
import {
  json,
  notFound,
  startFakeServer,
  type FakeServer,
} from "../bitbucket/fake-server";

const ENV_KEYS = [
  "DROID_STATE_FILE",
  "DROID_PROMPT_FILE",
  "REVIEW_POST_RESULTS_PATH",
  "DROID_PASS1_LOG",
  "DROID_PASS2_LOG",
  "DROID_SUCCESS",
  "DROID_ERROR_DETAILS",
  "GITLAB_TOKEN",
  "OVERRIDE_GITLAB_TOKEN",
  "CI_API_V4_URL",
  "GITLAB_API_URL",
  "CI_PROJECT_ID",
  "CI_MERGE_REQUEST_IID",
  "DROID_ERROR_FILE",
] as const;

let tmp: string;
let server: FakeServer;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "droid-gl-ucl-"));
  server = startFakeServer((req, url) => {
    if (req.method === "PUT") return json({ id: 99 });
    if (url.pathname === "/api/v4/user")
      return json({ id: 1, username: "droid" });
    if (url.pathname.endsWith("/notes/99"))
      return json({ id: 99, body: DROID_TRACKING_MARKER, author: { id: 1 } });
    return notFound();
  });
  process.env.DROID_STATE_FILE = path.join(tmp, ".droid-state.json");
  process.env.DROID_PROMPT_FILE = path.join(tmp, "droid-prompt.txt");
  process.env.DROID_PASS1_LOG = path.join(tmp, "pass1.jsonl");
  process.env.DROID_PASS2_LOG = path.join(tmp, "pass2.jsonl");
  process.env.GITLAB_TOKEN = "gl-test";
  process.env.CI_API_V4_URL = `${server.url}/api/v4`;
  process.env.CI_PROJECT_ID = "4242";
  process.env.CI_MERGE_REQUEST_IID = "7";
});

afterEach(async () => {
  server.stop();
  await fs.rm(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function runWithState(extra: Record<string, unknown> = {}) {
  await fs.writeFile(
    process.env.DROID_STATE_FILE!,
    JSON.stringify({
      shouldRunReview: true,
      projectId: "4242",
      mrIid: 7,
      trackingNoteId: 99,
      ...extra,
    }),
  );
  await run();
  const puts = server.requests.filter((r) => r.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(puts[0]!.path).toBe("/api/v4/projects/4242/merge_requests/7/notes/99");
  return puts[0]!.body.body as string;
}

describe("gitlab-update-comment-link", () => {
  it("reports success when the review ran through", async () => {
    const body = await runWithState();
    expect(body).not.toContain("Droid encountered an error");
  });

  it("reports a failure when Pass 1 left no usable candidates", async () => {
    const body = await runWithState({
      validatorSkippedReason: "review_candidates.json is not valid JSON",
    });
    expect(body).toContain("Droid encountered an error");
    expect(body).toContain(
      "Pass 1 did not produce valid review candidates (review_candidates.json is not valid JSON)",
    );
  });
});
