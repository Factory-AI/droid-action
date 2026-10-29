import { parseValidatedReview } from "../../src/core/review/validated/parse";
import {
  LEGACY_INLINE_BODY,
  LEGACY_FALLBACK_BODY,
  legacyCandidatesFromPrompt,
  legacyValidatedFromPrompt,
} from "../helpers/legacy-review-contract";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { run as prepare } from "../../src/entrypoints/bitbucket-prepare";
import { run as prepareValidator } from "../../src/entrypoints/bitbucket-prepare-validator";
import { run as postReview } from "../../src/entrypoints/bitbucket-post-review";
import { run as updateComment } from "../../src/entrypoints/bitbucket-update-comment-link";
import {
  BITBUCKET_TRACKING_MARKER,
  TRUNCATED_DIFF_NOTICE,
} from "../../src/bitbucket/operations/tracking-comment";
import { TRUNCATED_DIFF_NOTE } from "../../src/bitbucket/prompts";
import { stateFilePath } from "../../src/bitbucket/state";
import {
  APP_TS_DC_DIFF,
  APP_TS_DIFF,
  json,
  notFound,
  startFakeServer,
  type FakeServer,
  type RecordedRequest,
} from "./fake-server";

/**
 * A minimal stateful Bitbucket (Cloud or Data Center) that keeps comments
 * in memory, so the steps see each other's writes like on a real server.
 */
type Fake = {
  server: FakeServer;
  /** `author` defaults to the job identity (BOT). */
  comments: Array<{
    id: number;
    body: string;
    parentId: number | null;
    author?: string;
  }>;
  draft: boolean;
  /** Make the "who am I" endpoint fail, like a Cloud access token. */
  identityUnknown?: boolean;
  /** Data Center only: mark the diff as truncated. */
  diffTruncated?: boolean;
  /** Return a Response to override the default for a request. */
  override?: (req: RecordedRequest) => Response | undefined;
};

const CLOUD_REPO = "/2.0/repositories/acme/web-app";
const DC_REPO = "/bitbucket/rest/api/1.0/projects/PLAT/repos/billing";
const FULL_SHA = "abcdef123456" + "0".repeat(28);
const BOT = "droid-bot";

function startCloud(fake: Omit<Fake, "server">): Fake {
  const state = fake as Fake;
  let nextId = 1000;
  state.server = startFakeServer((req, url) => {
    const override = state.override?.(req);
    if (override) return override;
    const p = url.pathname;
    if (p === "/api/organization/managed-settings") return json({}, 404);
    if (p === "/2.0/user") {
      return state.identityUnknown
        ? json({ type: "error", error: { message: "Token is invalid" } }, 401)
        : json({ uuid: `{${BOT}}` });
    }
    if (p === `${CLOUD_REPO}/pullrequests/42`) {
      return json({
        id: 42,
        title: "Add c",
        description: "Adds const c",
        state: "OPEN",
        draft: state.draft,
        author: { nickname: "ada" },
        source: {
          branch: { name: "feature/c" },
          commit: { hash: "abcdef123456" },
        },
        destination: {
          branch: { name: "main" },
          commit: { hash: "0123456789ab" },
        },
        links: {
          html: { href: "https://bitbucket.org/acme/web-app/pull-requests/42" },
        },
      });
    }
    if (p === `${CLOUD_REPO}/pullrequests/42/diff`)
      return new Response(APP_TS_DIFF);
    if (p === `${CLOUD_REPO}/commit/abcdef123456`)
      return json({ hash: FULL_SHA });
    if (
      p === `${CLOUD_REPO}/pullrequests/42/comments` &&
      req.method === "GET"
    ) {
      return json({
        values: state.comments.map((c) => ({
          id: c.id,
          content: { raw: c.body },
          user: { uuid: `{${c.author ?? BOT}}` },
          ...(c.parentId ? { parent: { id: c.parentId } } : {}),
        })),
      });
    }
    if (
      p === `${CLOUD_REPO}/pullrequests/42/comments` &&
      req.method === "POST"
    ) {
      const c = { id: nextId++, body: req.body.content.raw, parentId: null };
      state.comments.push(c);
      return json(
        { id: c.id, content: { raw: c.body }, user: { uuid: `{${BOT}}` } },
        201,
      );
    }
    const edit = /\/pullrequests\/42\/comments\/(\d+)$/.exec(p);
    if (edit && req.method === "DELETE") {
      const i = state.comments.findIndex((x) => x.id === Number(edit[1]));
      if (i < 0) return notFound();
      state.comments.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    if (edit && req.method === "PUT") {
      const c = state.comments.find((x) => x.id === Number(edit[1]));
      if (!c) return notFound();
      c.body = req.body.content.raw;
      return json({ id: c.id, content: { raw: c.body } });
    }
    if (/\/commit\/[^/]+\/statuses\/build$/.test(p)) return json(req.body, 201);
    return notFound();
  });
  return state;
}

function startDataCenter(fake: Omit<Fake, "server">): Fake {
  const state = fake as Fake;
  let nextId = 500;
  const versions = new Map<number, number>();
  state.server = startFakeServer((req, url) => {
    const override = state.override?.(req);
    if (override) return override;
    const p = url.pathname;
    const pr = `${DC_REPO}/pull-requests/12`;
    if (p === "/api/organization/managed-settings") return json({}, 404);
    if (p === "/bitbucket/plugins/servlet/applinks/whoami") {
      return state.identityUnknown ? notFound() : new Response(BOT);
    }
    if (p === pr) {
      return json({
        id: 12,
        title: "Tax rules",
        description: "Adds VAT",
        state: "OPEN",
        draft: state.draft,
        fromRef: { displayId: "feature/tax", latestCommit: "c".repeat(40) },
        toRef: { displayId: "main", latestCommit: "d".repeat(40) },
        links: {
          self: [
            {
              href: `${state.server.url}/bitbucket/projects/PLAT/repos/billing/pull-requests/12`,
            },
          ],
        },
      });
    }
    if (p === `${pr}/diff`) {
      return json({
        diffs: [APP_TS_DC_DIFF],
        truncated: state.diffTruncated === true,
      });
    }
    if (p === `${pr}/activities`) {
      return json({
        isLastPage: true,
        start: 0,
        values: state.comments.map((c) => ({
          action: "COMMENTED",
          commentAction: "ADDED",
          comment: {
            id: c.id,
            version: versions.get(c.id) ?? 0,
            text: c.body,
            author: { name: c.author ?? BOT },
          },
        })),
      });
    }
    if (p === `${pr}/comments` && req.method === "POST") {
      const c = { id: nextId++, body: req.body.text, parentId: null };
      state.comments.push(c);
      versions.set(c.id, 0);
      return json(
        { id: c.id, version: 0, text: c.body, author: { name: BOT } },
        201,
      );
    }
    const one = new RegExp(`^${pr}/comments/(\\d+)$`).exec(p);
    if (one) {
      const c = state.comments.find((x) => x.id === Number(one[1]));
      if (!c) return notFound();
      const version = versions.get(c.id) ?? 0;
      if (req.method === "GET")
        return json({ id: c.id, version, text: c.body });
      if (req.method === "DELETE") {
        if (url.searchParams.get("version") !== String(version))
          return json({ errors: [{ message: "stale" }] }, 409);
        state.comments.splice(state.comments.indexOf(c), 1);
        return new Response(null, { status: 204 });
      }
      if (req.body.version !== version)
        return json({ errors: [{ message: "stale" }] }, 409);
      c.body = req.body.text;
      versions.set(c.id, version + 1);
      return json({ id: c.id, version: version + 1, text: c.body });
    }
    if (/\/commits\/[^/]+\/builds$/.test(p))
      return new Response(null, { status: 204 });
    return notFound();
  });
  return state;
}

const ENV_KEYS = [
  "BITBUCKET_WORKSPACE",
  "BITBUCKET_REPO_SLUG",
  "BITBUCKET_PR_ID",
  "BITBUCKET_COMMIT",
  "BITBUCKET_BUILD_NUMBER",
  "BITBUCKET_GIT_HTTP_ORIGIN",
  "BITBUCKET_STEP_UUID",
  "BITBUCKET_PIPELINE_UUID",
  "BITBUCKET_API_URL",
  "BITBUCKET_VARIANT",
  "BITBUCKET_SERVER_URL",
  "BITBUCKET_PROJECT_KEY",
  "DROID_PR_URL",
  "CHANGE_URL",
  "CHANGE_ID",
  "BUILD_URL",
  "BUILD_TAG",
  "GIT_COMMIT",
  "DROID_BUILD_URL",
  "DROID_RUN_ID",
  "bamboo_repository_pr_key",
  "bamboo_resultsUrl",
  "bamboo_buildResultKey",
  "bamboo_planRepository_revision",
  "DROID_BITBUCKET_TOKEN",
  "DROID_BITBUCKET_USERNAME",
  "DROID_BITBUCKET_API_TOKEN",
  "FACTORY_API_KEY",
  "FACTORY_API_BASE_URL",
  "AUTOMATIC_REVIEW",
  "AUTOMATIC_SECURITY_REVIEW",
  "REVIEW_DEPTH",
  "REVIEW_MODEL",
  "REASONING_EFFORT",
  "INCLUDE_SUGGESTIONS",
  "REVIEW_DRAFTS",
  "BUILD_STATUS",
  "DROID_SETTINGS",
  "DROID_PROMPT_FILE",
  "DROID_STATE_FILE",
  "REVIEW_CANDIDATES_PATH",
  "REVIEW_VALIDATED_PATH",
  "REVIEW_POST_RESULTS_PATH",
  "DROID_RESOLVED_ENV_FILE",
  "DROID_SUCCESS",
  "DROID_ERROR_FILE",
  "DROID_PASS1_LOG",
  "DROID_PASS2_LOG",
];

let tmp: string;
let saved: Record<string, string | undefined>;
let fake: Fake | undefined;

const deps = {
  setupSettings: async () => {},
  downgradeModel: (m: string | undefined) => m,
  retryDelayMs: 0,
};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "droid-bb-"));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.DROID_PROMPT_FILE = path.join(tmp, "droid-prompt.txt");
  process.env.FACTORY_API_KEY = "fk-test";
  process.env.DROID_BITBUCKET_TOKEN = "bb-secret";
});

async function writeErrorFile(text: string) {
  const file = path.join(tmp, "droid-error.txt");
  await fs.writeFile(file, text);
  process.env.DROID_ERROR_FILE = file;
}

afterEach(async () => {
  fake?.server.stop();
  fake = undefined;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

function useCloud(opts: Partial<Fake> = {}) {
  fake = startCloud({ comments: [], draft: false, ...opts });
  Object.assign(process.env, {
    BITBUCKET_WORKSPACE: "acme",
    BITBUCKET_REPO_SLUG: "web-app",
    BITBUCKET_PR_ID: "42",
    BITBUCKET_COMMIT: FULL_SHA,
    BITBUCKET_BUILD_NUMBER: "9",
    BITBUCKET_GIT_HTTP_ORIGIN: "http://bitbucket.org/acme/web-app",
    BITBUCKET_PIPELINE_UUID: "{pipe}",
    BITBUCKET_API_URL: `${fake.server.url}/2.0`,
    FACTORY_API_BASE_URL: fake.server.url,
  });
  return fake;
}

function useDataCenter(opts: Partial<Fake> = {}) {
  fake = startDataCenter({ comments: [], draft: false, ...opts });
  Object.assign(process.env, {
    CHANGE_ID: "12",
    CHANGE_URL: `${fake.server.url}/bitbucket/projects/PLAT/repos/billing/pull-requests/12`,
    BUILD_URL: "https://jenkins.example.com/job/billing/PR-12/1/",
    FACTORY_API_BASE_URL: fake.server.url,
  });
  return fake;
}

const reqs = (f: Fake, method: string, pathPart: string) =>
  f.server.requests.filter(
    (r) => r.method === method && r.path.includes(pathPart),
  );

async function writeValidated(
  results: unknown[],
  summary = "Two real issues.",
) {
  await fs.writeFile(
    path.join(tmp, "review_validated.json"),
    JSON.stringify({
      version: 1,
      results,
      reviewSummary: { status: "approved", body: summary },
    }),
  );
}

const VALIDATED = [
  {
    status: "approved",
    comment: {
      path: "src/app.ts",
      line: 3,
      side: "RIGHT",
      body: "[P1] c is unused",
    },
  },
  {
    status: "approved",
    comment: {
      path: "src/app.ts",
      line: null,
      old_line: 2,
      side: "LEFT",
      body: "[P2] b changed",
    },
  },
  {
    status: "approved",
    comment: {
      path: "src/app.ts",
      line: 40,
      side: "RIGHT",
      body: "[P2] far away",
    },
  },
  {
    status: "rejected",
    candidate: { path: "src/app.ts", line: 1, body: "nope" },
    reason: "false positive",
  },
];

describe("Bitbucket Cloud review steps", () => {
  it("runs prepare → post → final update against the API", async () => {
    const f = useCloud();
    process.env.BUILD_STATUS = "true";
    process.env.AUTOMATIC_SECURITY_REVIEW = "true";

    const state = await prepare(deps);

    expect(state).toMatchObject({
      shouldRunReview: true,
      prId: 42,
      repoFullName: "acme/web-app",
      headSha: FULL_SHA,
      sourceBranch: "feature/c",
      targetBranch: "main",
      securityReviewEnabled: true,
      target: {
        variant: "cloud",
        workspace: "acme",
        repoSlug: "web-app",
        prId: 42,
      },
    });
    // Every request authenticates with the configured token.
    for (const r of f.server.requests.filter((r) =>
      r.path.startsWith("/2.0"),
    )) {
      expect(r.headers.authorization).toBe("Bearer bb-secret");
    }

    const created = reqs(f, "POST", "/pullrequests/42/comments");
    expect(created).toHaveLength(1);
    expect(created[0]!.body.content.raw).toContain(BITBUCKET_TRACKING_MARKER);
    expect(created[0]!.body.content.raw).toContain(
      "Droid is reviewing this pull request",
    );
    expect(state.trackingCommentId).toBe(f.comments[0]!.id);

    const status = reqs(f, "POST", "/statuses/build");
    expect(status.map((r) => [r.path, r.body.state, r.body.key])).toEqual([
      [
        `${CLOUD_REPO}/commit/${FULL_SHA}/statuses/build`,
        "INPROGRESS",
        "droid-review",
      ],
    ]);
    expect(status[0]!.body.url).toBe(
      "http://bitbucket.org/acme/web-app/pipelines/results/9",
    );

    expect(await fs.readFile(state.diffPath!, "utf8")).toBe(APP_TS_DIFF);
    expect(await fs.readFile(state.descriptionPath!, "utf8")).toBe(
      "Title: Add c\n\nAdds const c\n",
    );
    const prompt = await fs.readFile(state.promptPath!, "utf8");
    expect(prompt).toContain("acme/web-app");
    expect(prompt).toContain(state.candidatesPath!);
    expect(prompt).toContain("security-reviewer");
    const shim = await fs.readFile(path.join(tmp, "resolved-env.sh"), "utf8");
    expect(shim).toContain("export RESOLVED_MODEL='openai-latest-balanced'");
    expect(shim).toContain('"platform":"bitbucket"');
    expect(shim).toContain('"runId":"{pipe}"');
    expect(shim).not.toContain("bb-secret");

    await fs.writeFile(
      state.candidatesPath!,
      JSON.stringify({ comments: [{}, {}] }),
    );
    await prepareValidator();
    expect(await fs.readFile(state.promptPath!, "utf8")).toContain(
      "Phase 2 (validator)",
    );

    await writeValidated(VALIDATED);
    await postReview({ retryDelayMs: 0 });

    const posted = reqs(f, "POST", "/pullrequests/42/comments")
      .slice(1)
      .map((r) => r.body);
    expect(posted).toEqual([
      {
        content: { raw: "[P1] c is unused" },
        inline: { path: "src/app.ts", to: 3 },
      },
      {
        content: { raw: "[P2] b changed" },
        inline: { path: "src/app.ts", from: 2 },
      },
      { content: { raw: expect.stringContaining("`src/app.ts:40`") } },
    ]);
    const results = JSON.parse(
      await fs.readFile(path.join(tmp, "review_post_results.json"), "utf8"),
    );
    expect(results).toMatchObject({
      posted: 2,
      fallbackPosted: 1,
      approved: 3,
      rejected: 1,
      failed: 0,
    });

    const pass1 = path.join(tmp, "pass1.jsonl");
    await fs.writeFile(
      pass1,
      '{"type":"completion","session_id":"sess-1","numTurns":4,"durationMs":2000}\n',
    );
    process.env.DROID_PASS1_LOG = pass1;
    await updateComment({ retryDelayMs: 0 });

    const tracking = f.comments.find((c) => c.id === state.trackingCommentId)!;
    expect(tracking.body).toContain(
      "Droid finished reviewing this pull request",
    );
    expect(tracking.body).toContain("Two real issues.");
    expect(tracking.body).toContain(
      "2 inline comments posted · 1 posted as a regular comment",
    );
    expect(tracking.body).toContain("Security review: enabled");
    expect(tracking.body).toContain("pass 1 `sess-1`");
    expect(reqs(f, "POST", "/statuses/build").map((r) => r.body.state)).toEqual(
      ["INPROGRESS", "SUCCESSFUL"],
    );
  });

  it("reuses the existing tracking comment instead of posting a new one", async () => {
    const f = useCloud({
      comments: [
        { id: 7, body: "nice", parentId: null },
        { id: 8, body: `${BITBUCKET_TRACKING_MARKER}\n\nold`, parentId: null },
      ],
    });

    const state = await prepare(deps);

    expect(state.trackingCommentId).toBe(8);
    expect(reqs(f, "POST", "/comments")).toHaveLength(0);
    expect(reqs(f, "PUT", "/comments/8")).toHaveLength(1);
    expect(f.comments[1]!.body).toContain("Droid is reviewing");
    expect(reqs(f, "POST", "/statuses/build")).toHaveLength(0);
  });

  it("does not adopt a tracking marker pasted by another user", async () => {
    const f = useCloud({
      comments: [
        {
          id: 8,
          body: `${BITBUCKET_TRACKING_MARKER}\n\nspoofed`,
          parentId: null,
          author: "mallory",
        },
      ],
    });

    const state = await prepare(deps);

    expect(state.trackingCommentId).toBe(1000);
    expect(reqs(f, "PUT", "/comments/8")).toHaveLength(0);
    expect(f.comments[0]!.body).toContain("spoofed");

    await updateComment({ retryDelayMs: 0 });
    expect(reqs(f, "PUT", "/comments/8")).toHaveLength(0);
    expect(f.comments[1]!.body).toContain("Droid finished reviewing");
  });

  it("keeps one tracking comment when the job identity is unknown, deleting only its own earlier ones", async () => {
    const tracker = (author?: string) => ({
      body: `${BITBUCKET_TRACKING_MARKER}\n\nold`,
      parentId: null,
      author,
    });
    const f = useCloud({
      identityUnknown: true,
      comments: [
        { id: 8, ...tracker() },
        { id: 9, ...tracker("mallory") },
        { id: 10, ...tracker() },
        { id: 11, body: "why?", parentId: 10, author: "ada" },
      ],
    });

    const state = await prepare(deps);

    expect(state.trackingCommentId).toBe(1000);
    expect(reqs(f, "PUT", "/comments/8")).toHaveLength(0);
    expect(reqs(f, "DELETE", "/comments").map((r) => r.path)).toEqual([
      `${CLOUD_REPO}/pullrequests/42/comments/8`,
    ]);
    expect(f.comments.map((c) => c.id)).toEqual([9, 10, 11, 1000]);
  });

  it("still reviews when an earlier tracking comment cannot be deleted", async () => {
    const f = useCloud({
      identityUnknown: true,
      comments: [
        { id: 8, body: `${BITBUCKET_TRACKING_MARKER}\nold`, parentId: null },
      ],
    });
    f.override = (req) =>
      req.method === "DELETE"
        ? json({ error: { message: "no" } }, 403)
        : undefined;

    const state = await prepare(deps);

    expect(state.shouldRunReview).toBe(true);
    expect(state.trackingCommentId).toBe(1000);
  });

  it("does not edit another user's comment when the state's tracking comment id is tampered with", async () => {
    const f = useCloud({
      comments: [
        {
          id: 8,
          body: `${BITBUCKET_TRACKING_MARKER}\n\nmallory's`,
          parentId: null,
          author: "mallory",
        },
      ],
    });
    const state = await prepare(deps);
    const statePath = stateFilePath();
    await fs.writeFile(
      statePath,
      JSON.stringify({ ...state, trackingCommentId: 8 }),
    );

    await updateComment({ retryDelayMs: 0 });

    expect(reqs(f, "PUT", "/comments/8")).toHaveLength(0);
    expect(f.comments[0]!.body).toContain("mallory's");
    expect(reqs(f, "POST", "/comments")).toHaveLength(2);
  });

  it("refuses to post when the state targets a different pull request", async () => {
    const f = useCloud();
    const state = await prepare(deps);
    const statePath = stateFilePath();
    await fs.writeFile(
      statePath,
      JSON.stringify({ ...state, target: { ...state.target, prId: 43 } }),
    );

    await expect(updateComment({ retryDelayMs: 0 })).rejects.toThrow(
      /different pull request/,
    );
    await writeValidated([]);
    await expect(postReview({ retryDelayMs: 0 })).rejects.toThrow(
      /different pull request/,
    );
    expect(reqs(f, "PUT", "/pullrequests/43")).toHaveLength(0);
    expect(
      f.server.requests.some((r) => r.path.includes("/pullrequests/43")),
    ).toBe(false);
  });

  it("skips draft pull requests unless REVIEW_DRAFTS is set", async () => {
    const f = useCloud({ draft: true });
    process.env.BUILD_STATUS = "true";

    const state = await prepare(deps);

    expect(state).toMatchObject({
      shouldRunReview: false,
      reason: "draft",
      trackingCommentId: null,
    });
    expect(reqs(f, "POST", "/comments")).toHaveLength(0);
    // A SUCCESSFUL status would still count once the draft is marked ready.
    expect(reqs(f, "POST", "/statuses/build")).toHaveLength(0);

    process.env.REVIEW_DRAFTS = "true";
    expect((await prepare(deps)).shouldRunReview).toBe(true);
  });

  it("makes no API calls outside a pull request build or with review disabled", async () => {
    const f = useCloud();
    delete process.env.BITBUCKET_PR_ID;
    expect(await prepare(deps)).toMatchObject({
      shouldRunReview: false,
      reason: "not-pull-request",
    });

    process.env.BITBUCKET_PR_ID = "42";
    process.env.AUTOMATIC_REVIEW = "false";
    expect(await prepare(deps)).toMatchObject({
      reason: "automatic-review-disabled",
    });
    expect(f.server.requests).toHaveLength(0);

    // Later steps no-op on a skipped state.
    await prepareValidator();
    await postReview();
    await updateComment();
    expect(f.server.requests).toHaveLength(0);
  });

  it("fails before touching the PR when FACTORY_API_KEY is missing", async () => {
    const f = useCloud();
    delete process.env.FACTORY_API_KEY;
    await expect(prepare(deps)).rejects.toThrow(/Missing FACTORY_API_KEY/);
    expect(reqs(f, "POST", "/comments")).toHaveLength(0);
  });

  it("treats a FACTORY_API_KEY Bamboo never expanded as missing", async () => {
    const f = useCloud();
    process.env.FACTORY_API_KEY = "${bamboo.FACTORY_API_KEY_SECRET}";
    await expect(prepare(deps)).rejects.toThrow(/Missing FACTORY_API_KEY/);
    expect(reqs(f, "POST", "/comments")).toHaveLength(0);
  });

  it("posts the build status on the full head SHA when the CI gives none", async () => {
    const f = useCloud();
    delete process.env.BITBUCKET_COMMIT;
    process.env.BUILD_STATUS = "true";

    const state = await prepare(deps);

    expect(state.headSha).toBe(FULL_SHA);
    expect(reqs(f, "POST", "/statuses/build").map((r) => r.path)).toEqual([
      `${CLOUD_REPO}/commit/${FULL_SHA}/statuses/build`,
    ]);
  });

  it("skips the build status rather than post it on an abbreviated SHA", async () => {
    const f = useCloud();
    delete process.env.BITBUCKET_COMMIT;
    process.env.BUILD_STATUS = "true";
    f.override = (req) =>
      req.path.endsWith("/commit/abcdef123456") ? notFound() : undefined;

    const state = await prepare(deps);

    expect(state.headSha).toBe("abcdef123456");
    expect(reqs(f, "POST", "/statuses/build")).toHaveLength(0);
  });

  it("creates the tracking comment before fetching the diff, so a diff failure shows on the PR", async () => {
    const f = useCloud();
    f.override = (req) =>
      req.path.endsWith("/pullrequests/42/diff")
        ? json({ type: "error", error: { message: "diff exploded" } }, 500)
        : undefined;

    await expect(prepare(deps)).rejects.toThrow(/diff exploded/);
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]!.body).toContain("Droid is reviewing");

    process.env.DROID_SUCCESS = "false";
    await writeErrorFile("bitbucket-prepare failed");
    await updateComment({ retryDelayMs: 0 });
    expect(f.comments[0]!.body).toContain("Droid encountered an error");
    expect(f.comments[0]!.body).toContain("bitbucket-prepare failed");
  });

  it("reports a prepare failure that happens after the tracking comment exists", async () => {
    const f = useCloud();
    await expect(
      prepare({
        ...deps,
        downgradeModel: () => {
          throw new Error("droid CLI missing");
        },
      }),
    ).rejects.toThrow("droid CLI missing");

    process.env.DROID_SUCCESS = "true";
    await updateComment({ retryDelayMs: 0 });

    expect(f.comments[0]!.body).toContain("Droid encountered an error");
    expect(f.comments[0]!.body).toContain("The prepare step did not finish.");
  });

  it("marks the review failed with error details and a FAILED build status", async () => {
    const f = useCloud();
    process.env.BUILD_STATUS = "true";
    await prepare(deps);

    process.env.DROID_SUCCESS = "false";
    await writeErrorFile("droid exec pass 1 (candidates) failed");
    await updateComment({ retryDelayMs: 0 });

    expect(f.comments[0]!.body).toContain("**Error details**");
    expect(f.comments[0]!.body).toContain(
      "droid exec pass 1 (candidates) failed",
    );
    expect(reqs(f, "POST", "/statuses/build").at(-1)!.body.state).toBe(
      "FAILED",
    );
  });

  it("never publishes a file the error path was symlinked to", async () => {
    const f = useCloud();
    await prepare(deps);
    // The review passes can write to the scratch directory.
    const secretFile = path.join(tmp, "credentials");
    await fs.writeFile(secretFile, "TOP SECRET CONTENTS");
    const errorFile = path.join(tmp, "droid-error.txt");
    await fs.symlink(secretFile, errorFile);
    process.env.DROID_ERROR_FILE = errorFile;
    process.env.DROID_SUCCESS = "false";

    await updateComment({ retryDelayMs: 0 });

    expect(f.comments[0]!.body).toContain("Droid encountered an error");
    expect(f.comments[0]!.body).not.toContain("TOP SECRET");
  });

  it("redacts credentials from the error details and every comment it posts", async () => {
    const f = useCloud();
    await prepare(deps);
    process.env.DROID_SUCCESS = "false";
    await writeErrorFile("curl failed: Authorization: Bearer bb-secret");

    await updateComment({ retryDelayMs: 0 });

    expect(f.comments[0]!.body).toContain("Bearer [REDACTED]");
    for (const r of f.server.requests) {
      expect(JSON.stringify(r.body ?? "")).not.toContain("bb-secret");
    }
  });

  it("fails the posting step when no approved comment reaches the PR", async () => {
    const f = useCloud();
    await prepare(deps);
    await writeValidated([VALIDATED[0]]);
    f.override = (req) =>
      req.method === "POST" && req.path.endsWith("/comments")
        ? json({ type: "error", error: { message: "Forbidden" } }, 403)
        : undefined;

    await expect(postReview({ retryDelayMs: 0 })).rejects.toThrow(
      /all 1 approved comments failed to post\. First error: .*Bitbucket API 403/,
    );
  });

  it("reports a failed review when Pass 1 left no usable candidates", async () => {
    const f = useCloud();
    process.env.BUILD_STATUS = "true";
    await prepare(deps);
    // Pass 1 wrote no candidates file.
    await prepareValidator();
    expect(
      await fs.readFile(path.join(tmp, "droid-prompt.txt"), "utf8"),
    ).toContain("No review findings to validate");

    const before = f.server.requests.length;
    await expect(postReview()).rejects.toThrow(
      /Pass 1 did not produce valid review candidates/,
    );
    expect(f.server.requests.length).toBe(before);

    // Even if the job script did not fail, the final report must.
    process.env.DROID_SUCCESS = "true";
    await updateComment({ retryDelayMs: 0 });
    expect(f.comments[0]!.body).toContain("Droid encountered an error");
    expect(f.comments[0]!.body).toContain(
      "Pass 1 did not produce valid review candidates",
    );
    expect(reqs(f, "POST", "/statuses/build").at(-1)!.body.state).toBe(
      "FAILED",
    );
  });

  it("anchors nothing inline on Cloud when the PR changed after the review", async () => {
    const f = useCloud();
    await prepare(deps);
    await writeValidated([VALIDATED[0]]);
    const moved = "9".repeat(40);
    f.override = (req) => {
      if (req.path === `${CLOUD_REPO}/pullrequests/42`) {
        return json({
          id: 42,
          title: "Add c",
          state: "OPEN",
          source: { branch: { name: "feature/c" }, commit: { hash: moved } },
          destination: {
            branch: { name: "main" },
            commit: { hash: "0123456789ab" },
          },
        });
      }
      return undefined;
    };

    await postReview({ retryDelayMs: 0 });

    const posted = reqs(f, "POST", "/pullrequests/42/comments").slice(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body.inline).toBeUndefined();
    expect(posted[0]!.body.content.raw).toContain(
      `reviewed at commit ${FULL_SHA.slice(0, 12)}; the pull request has changed since`,
    );
    expect(posted[0]!.body.content.raw).toContain("[P1] c is unused");
  });

  it("still anchors inline on Cloud when the PR head is unchanged", async () => {
    const f = useCloud();
    await prepare(deps);
    await writeValidated([VALIDATED[0]]);
    await postReview({ retryDelayMs: 0 });
    const posted = reqs(f, "POST", "/pullrequests/42/comments").slice(1);
    expect(posted[0]!.body.inline).toEqual({ path: "src/app.ts", to: 3 });
  });

  it("refuses to report success when Pass 2 wrote nothing", async () => {
    useCloud();
    const state = await prepare(deps);
    await fs.writeFile(state.candidatesPath!, JSON.stringify({ comments: [] }));
    await prepareValidator();
    await expect(postReview()).rejects.toThrow(/Pass 2 did not write/);
  });
});

describe("Bitbucket Data Center review steps (Jenkins)", () => {
  it("runs the full flow from CHANGE_URL with DC anchors and versioned updates", async () => {
    const f = useDataCenter();
    process.env.BUILD_STATUS = "true";

    const state = await prepare(deps);

    expect(state).toMatchObject({
      shouldRunReview: true,
      prId: 12,
      repoFullName: "PLAT/billing",
      headSha: "c".repeat(40),
      buildUrl: "https://jenkins.example.com/job/billing/PR-12/1/",
      target: {
        variant: "datacenter",
        serverUrl: `${f.server.url}/bitbucket`,
        projectKey: "PLAT",
        repoSlug: "billing",
      },
    });
    expect(
      reqs(f, "POST", "/pull-requests/12/comments")[0]!.body.text,
    ).toContain(BITBUCKET_TRACKING_MARKER);
    expect(reqs(f, "POST", "/builds")[0]).toMatchObject({
      path: `${DC_REPO}/commits/${"c".repeat(40)}/builds`,
    });
    // Required builds match on parent and ref, so both must be on the wire.
    expect(reqs(f, "POST", "/builds")[0]!.body).toEqual({
      key: "droid-review",
      state: "INPROGRESS",
      name: "Droid code review",
      url: "https://jenkins.example.com/job/billing/PR-12/1/",
      description: "Droid is reviewing",
      parent: "droid-review",
      ref: "refs/heads/feature/tax",
    });
    expect(await fs.readFile(state.diffPath!, "utf8")).toContain(
      "+const c = 4;",
    );

    await writeValidated(VALIDATED);
    await postReview({ retryDelayMs: 0 });

    const anchors = reqs(f, "POST", "/pull-requests/12/comments")
      .slice(1)
      .map((r) => r.body.anchor ?? null);
    expect(anchors).toEqual([
      {
        diffType: "EFFECTIVE",
        path: "src/app.ts",
        line: 3,
        lineType: "ADDED",
        fileType: "TO",
        fromHash: "d".repeat(40),
        toHash: "c".repeat(40),
      },
      {
        diffType: "EFFECTIVE",
        path: "src/app.ts",
        line: 2,
        lineType: "REMOVED",
        fileType: "FROM",
        fromHash: "d".repeat(40),
        toHash: "c".repeat(40),
      },
      null,
    ]);

    await updateComment({ retryDelayMs: 0 });
    const puts = reqs(f, "PUT", `/comments/${state.trackingCommentId}`);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body.version).toBe(0);
    expect(f.comments[0]!.body).toContain("Droid finished reviewing");
    expect(reqs(f, "POST", "/builds").at(-1)!.body).toMatchObject({
      state: "SUCCESSFUL",
      parent: "droid-review",
      ref: "refs/heads/feature/tax",
    });
  });

  it("tells both passes and the PR when the server truncated the diff", async () => {
    const f = useDataCenter({ diffTruncated: true });

    const state = await prepare(deps);

    expect(state.diffTruncated).toBe(true);
    expect(await fs.readFile(state.promptPath!, "utf8")).toStartWith(
      TRUNCATED_DIFF_NOTE,
    );
    await fs.writeFile(
      state.candidatesPath!,
      JSON.stringify({ comments: [{}] }),
    );
    await prepareValidator();
    const validator = await fs.readFile(state.promptPath!, "utf8");
    expect(validator).toStartWith(TRUNCATED_DIFF_NOTE);
    expect(validator).toContain("Phase 2 (validator)");

    await writeValidated([]);
    await postReview({ retryDelayMs: 0 });
    await updateComment({ retryDelayMs: 0 });
    expect(f.comments[0]!.body).toContain(TRUNCATED_DIFF_NOTICE);
  });

  it("does not flag a complete diff as truncated", async () => {
    const f = useDataCenter();
    const state = await prepare(deps);
    expect(state.diffTruncated).toBeUndefined();
    expect(await fs.readFile(state.promptPath!, "utf8")).not.toContain(
      TRUNCATED_DIFF_NOTE,
    );
    await updateComment({ retryDelayMs: 0 });
    expect(f.comments[0]!.body).not.toContain(TRUNCATED_DIFF_NOTICE);
  });

  it("posts no build status for a skipped draft", async () => {
    const f = useDataCenter({ draft: true });
    process.env.BUILD_STATUS = "true";

    expect(await prepare(deps)).toMatchObject({ reason: "draft" });
    expect(reqs(f, "POST", "/builds")).toHaveLength(0);
  });

  it("reuses the tracking comment found in the activity feed", async () => {
    const f = useDataCenter({
      comments: [
        {
          id: 3,
          body: `${BITBUCKET_TRACKING_MARKER}\nprevious run`,
          parentId: null,
        },
      ],
    });
    const state = await prepare(deps);
    expect(state.trackingCommentId).toBe(3);
    expect(reqs(f, "POST", "/comments")).toHaveLength(0);
    expect(reqs(f, "PUT", "/comments/3")[0]!.body).toMatchObject({
      version: 0,
    });
  });

  it("does not adopt a tracking comment another Data Center user wrote", async () => {
    const f = useDataCenter({
      comments: [
        {
          id: 3,
          body: `${BITBUCKET_TRACKING_MARKER}\nspoofed`,
          parentId: null,
          author: "mallory",
        },
      ],
    });
    const state = await prepare(deps);
    expect(state.trackingCommentId).toBe(500);
    expect(reqs(f, "PUT", "/comments/3")).toHaveLength(0);
  });

  it("deletes its own earlier tracking comment with the current version when whoami fails", async () => {
    const f = useDataCenter({
      identityUnknown: true,
      comments: [
        { id: 3, body: `${BITBUCKET_TRACKING_MARKER}\nold`, parentId: null },
        {
          id: 4,
          body: `${BITBUCKET_TRACKING_MARKER}\nspoofed`,
          parentId: null,
          author: "mallory",
        },
      ],
    });
    const state = await prepare(deps);
    expect(state.trackingCommentId).toBe(500);
    expect(f.comments.map((c) => c.id)).toEqual([4, 500]);
  });

  it("reports a clear 401 for a bad token", async () => {
    const f = useDataCenter();
    f.override = () =>
      json(
        {
          errors: [
            {
              message:
                "Authentication failed. Please check your credentials and try again.",
            },
          ],
        },
        401,
      );
    await expect(prepare(deps)).rejects.toThrow(
      /Bitbucket API 401: Unauthorized .*Authentication failed/,
    );
  });
});

describe("legacy platform contract through real Bitbucket pipeline", () => {
  for (const variant of ["Cloud", "Data Center"]) {
    it(`${variant} preserves the generated legacy contract through inline and outside-hunk fallback`, async () => {
      const f = variant === "Cloud" ? useCloud() : useDataCenter();
      process.env.INCLUDE_SUGGESTIONS = "true";
      process.env.AUTOMATIC_SECURITY_REVIEW = "true";
      const state = await prepare(deps);
      const candidatesPrompt = await fs.readFile(state.promptPath!, "utf8");
      const candidates = legacyCandidatesFromPrompt(candidatesPrompt, {
        path: "src/app.ts",
        inlineLine: 3,
        headSha: state.headSha!,
      });
      expect(candidates.comments).toHaveLength(2);
      expect(candidatesPrompt).toContain("suggestion block rules");
      await fs.writeFile(state.candidatesPath!, JSON.stringify(candidates));
      await prepareValidator();
      const validatorPrompt = await fs.readFile(state.promptPath!, "utf8");
      const validated = legacyValidatedFromPrompt(validatorPrompt, {
        path: "src/app.ts",
        inlineLine: 3,
        headSha: state.headSha!,
      });
      expect(validated.results).toHaveLength(2);
      const parsed = parseValidatedReview(JSON.stringify(validated));
      expect(parsed.approved).toHaveLength(2);
      expect(parsed.outsideDiff).toHaveLength(0);
      expect(parsed.skipped).toEqual([]);
      expect(parsed.approved.map((comment) => comment.body)).toEqual([
        LEGACY_INLINE_BODY,
        LEGACY_FALLBACK_BODY,
      ]);
      await fs.writeFile(state.validatedPath!, JSON.stringify(validated));
      const commentsPath =
        variant === "Cloud"
          ? "/pullrequests/42/comments"
          : "/pull-requests/12/comments";
      const before = reqs(f, "POST", commentsPath).length;
      await postReview({ retryDelayMs: 0 });
      const posted = reqs(f, "POST", commentsPath).slice(before);
      expect(posted).toHaveLength(2);
      const inline = posted[0]!.body;
      const fallback = posted[1]!.body;
      if (variant === "Cloud") {
        expect(inline.content.raw).toBe(LEGACY_INLINE_BODY);
        expect(inline.inline).toEqual({ path: "src/app.ts", to: 3 });
        expect(fallback).not.toHaveProperty("inline");
        expect(fallback.content.raw).toBe(
          "**`src/app.ts:40`** (could not be posted inline, so the finding is posted as a regular comment)\n\n" +
            LEGACY_FALLBACK_BODY,
        );
      } else {
        expect(inline.text).toBe(LEGACY_INLINE_BODY);
        expect(inline.anchor).toMatchObject({ path: "src/app.ts", line: 3 });
        expect(fallback).not.toHaveProperty("anchor");
        expect(fallback.text).toBe(
          "**`src/app.ts:40`** (could not be posted inline, so the finding is posted as a regular comment)\n\n" +
            LEGACY_FALLBACK_BODY,
        );
      }
      const results = JSON.parse(
        await fs.readFile(path.join(tmp, "review_post_results.json"), "utf8"),
      );
      expect(results).toMatchObject({
        posted: 1,
        fallbackPosted: 1,
        approved: 2,
        rejected: 0,
        failed: 0,
        skipped: 0,
        failures: [],
      });
      expect(results.summaryBody).toBe(validated.reviewSummary.body);
    });
  }
});
