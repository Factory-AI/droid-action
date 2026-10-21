import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { run as prepare } from "../../src/entrypoints/azure-devops-prepare";
import { run as prepareValidator } from "../../src/entrypoints/azure-devops-prepare-validator";
import { run as postReview } from "../../src/entrypoints/azure-devops-post-review";
import { run as updateTracking } from "../../src/entrypoints/azure-devops-update-comment-link";
import {
  postResultsFilePath,
  type AzureDevopsPrepareState,
} from "../../src/azure-devops/paths";
import { DROID_TRACKING_PROPERTY } from "../../src/azure-devops/operations/tracking-thread";
import {
  SERVICES_ENV,
  createFakeAdo,
  createPrRepo,
  git,
  json,
  tempDir,
} from "./helpers";

const repo = createPrRepo();
const dirs: string[] = [repo.dir];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// The runtime addresses the project by id, which never needs escaping.
const PR_PATH =
  "/6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/17";

function envFor(extra: Record<string, string> = {}) {
  const prompts = tempDir("ado-prompts-");
  dirs.push(prompts);
  return {
    ...SERVICES_ENV,
    SYSTEM_PULLREQUEST_SOURCECOMMITID: repo.source,
    BUILD_SOURCESDIRECTORY: repo.dir,
    DROID_PROMPT_FILE: path.join(prompts, "droid-prompt.txt"),
    ...extra,
  } as NodeJS.ProcessEnv;
}

function pullRequest(over: Record<string, unknown> = {}) {
  return {
    pullRequestId: 17,
    status: "active",
    isDraft: false,
    title: "Add line4",
    description: "Adds a line",
    sourceRefName: "refs/heads/feature",
    targetRefName: "refs/heads/main",
    createdBy: { id: "u1", displayName: "Ada Lovelace" },
    ...over,
  };
}

function fakeAdo(pr = pullRequest()) {
  const fake = createFakeAdo();
  fake.on("GET", `${PR_PATH}`, () => json(pr));
  fake.on("GET", `${PR_PATH}/threads`, () =>
    json({
      value: [
        {
          id: 3,
          status: "active",
          threadContext: {
            filePath: "/app.ts",
            rightFileStart: { line: 2, offset: 1 },
            rightFileEnd: { line: 2, offset: 1 },
          },
          comments: [
            {
              id: 1,
              content: "Why this change?",
              author: { id: "u2", displayName: "Bo" },
              commentType: "text",
            },
          ],
        },
      ],
      count: 1,
    }),
  );
  // Echo the thread back the way Azure DevOps does: same fields plus ids.
  fake.on("POST", `${PR_PATH}/threads`, (req) => {
    const sent = req.body as { comments: object[] };
    return json({
      ...sent,
      id: 50 + fake.requests.length,
      comments: sent.comments.map((c, i) => ({ ...c, id: i + 1 })),
    });
  });
  fake.on("GET", `${PR_PATH}/iterations`, () =>
    json({
      value: [
        {
          id: 1,
          sourceRefCommit: { commitId: repo.common },
          targetRefCommit: { commitId: repo.common },
          commonRefCommit: { commitId: repo.common },
        },
        {
          id: 2,
          sourceRefCommit: { commitId: repo.source },
          targetRefCommit: { commitId: repo.target },
          commonRefCommit: { commitId: repo.common },
        },
      ],
      count: 2,
    }),
  );
  fake.on("GET", `${PR_PATH}/iterations/2/changes`, () =>
    json({
      changeEntries: [
        {
          changeTrackingId: 7,
          changeId: 1,
          item: { path: "/app.ts" },
          changeType: "edit",
        },
        {
          changeTrackingId: 8,
          changeId: 2,
          item: { path: "/old.ts" },
          changeType: "delete",
        },
      ],
    }),
  );
  fake.on("PATCH", /\/threads\/\d+\/comments\/1$/, (req) =>
    json({ id: 1, ...(req.body as object) }),
  );
  return fake;
}

const deps = (
  env: NodeJS.ProcessEnv,
  fake: ReturnType<typeof createFakeAdo>,
) => ({
  env,
  fetch: fake.fetch,
  resolveModel: async () => ({
    model: "openai-latest-premium",
    reasoningEffort: "high",
  }),
  setupSettings: async () => {},
});

const readState = (env: NodeJS.ProcessEnv): AzureDevopsPrepareState =>
  JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(env.DROID_PROMPT_FILE!), ".droid-state.json"),
      "utf8",
    ),
  );

describe("azure-devops-prepare", () => {
  it("does nothing for a non-PR build, without needing a token", async () => {
    const fake = fakeAdo();
    const { SYSTEM_ACCESSTOKEN: _, ...noToken } = envFor({
      BUILD_REASON: "IndividualCI",
    });
    const state = await prepare(deps(noToken, fake));
    expect(state.shouldRunReview).toBe(false);
    expect(state.reason).toContain("not-pull-request-build");
    expect(fake.requests).toHaveLength(0);
  });

  it("skips draft pull requests before posting anything", async () => {
    const fake = fakeAdo(pullRequest({ isDraft: true }));
    const env = envFor();
    const state = await prepare(deps(env, fake));
    expect(state.reason).toBe("draft-pull-request");
    expect(fake.requests.map((r) => r.method)).toEqual(["GET"]);
    expect(readState(env).shouldRunReview).toBe(false);
  });

  it("reviews draft pull requests when REVIEW_DRAFTS is true", async () => {
    const fake = fakeAdo(pullRequest({ isDraft: true }));
    const env = envFor({ REVIEW_DRAFTS: "true" });
    const state = await prepare(deps(env, fake));
    expect(state.shouldRunReview).toBe(true);
    expect(state.reason).toBeUndefined();
    expect(fs.existsSync(state.promptPath!)).toBe(true);
    expect(
      fake.requests.some(
        (r) => r.method === "POST" && r.url.includes(`${PR_PATH}/threads`),
      ),
    ).toBe(true);
  });

  it("skips abandoned pull requests", async () => {
    const fake = fakeAdo(pullRequest({ status: "abandoned" }));
    const state = await prepare(deps(envFor(), fake));
    expect(state.reason).toBe("pull-request-abandoned");
  });

  it("creates the tracking thread, checks out the source commit, and writes artifacts + prompt", async () => {
    git(repo.dir, "checkout", "-q", repo.merge);
    const fake = fakeAdo();
    const env = envFor();
    const state = await prepare(deps(env, fake));

    const tracking = fake.requests.find((r) => r.method === "POST")!;
    expect(tracking.headers.Authorization).toBe("Bearer job-token-secret");
    const trackingBody = tracking.body as {
      comments: Array<{ content: string }>;
      properties: object;
    };
    expect(trackingBody.properties).toHaveProperty([DROID_TRACKING_PROPERTY]);
    expect(trackingBody.comments[0]!.content).toContain(
      "Droid is reviewing this pull request",
    );
    expect(trackingBody.comments[0]!.content).toContain(
      "Build: https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=4521",
    );

    expect(git(repo.dir, "rev-parse", "HEAD")).toBe(repo.source);
    expect(state).toMatchObject({
      shouldRunReview: true,
      pullRequestId: 17,
      iterationId: 2,
      trackingCommentId: 1,
      headSha: repo.source,
      sourceBranch: "feature",
      targetBranch: "main",
      repository: "Fabrikam Web/web-app",
      resolvedModel: "openai-latest-premium",
    });
    expect(readState(env)).toEqual(state);

    const diff = fs.readFileSync(state.diffPath!, "utf8");
    expect(diff).toContain("+line4");
    expect(diff).not.toContain("main-only.ts");
    const comments = JSON.parse(fs.readFileSync(state.commentsPath!, "utf8"));
    expect(comments[0].comments[0].content).toBe("Why this change?");

    const prompt = fs.readFileSync(state.promptPath!, "utf8");
    expect(prompt).toContain("Azure DevOps");
    expect(prompt).toContain(state.candidatesPath!);
    expect(prompt).toContain(repo.source);

    const shim = fs.readFileSync(
      path.join(path.dirname(env.DROID_PROMPT_FILE!), "resolved-env.sh"),
      "utf8",
    );
    expect(shim).toContain("export RESOLVED_MODEL='openai-latest-premium'");
    expect(shim).toContain('"platform":"azure-devops"');
    expect(shim).toContain('"runId":"4521"');
  });

  it("reuses an existing tracking thread on re-runs", async () => {
    const env = envFor();
    const existing = createFakeAdo();
    existing.on("GET", `${PR_PATH}`, () => json(pullRequest()));
    existing.on("GET", `${PR_PATH}/threads`, () =>
      json({
        value: [
          {
            id: 40,
            comments: [{ id: 1, content: "<!-- droid-tracking-note -->\nold" }],
          },
        ],
      }),
    );
    existing.on("PATCH", `${PR_PATH}/threads/40/comments/1`, () =>
      json({ id: 1 }),
    );
    existing.on("GET", `${PR_PATH}/iterations`, () =>
      json({
        value: [
          {
            id: 2,
            sourceRefCommit: { commitId: repo.source },
            targetRefCommit: { commitId: repo.target },
            commonRefCommit: { commitId: repo.common },
          },
        ],
      }),
    );
    const state = await prepare(deps(env, existing));
    expect(state.trackingThreadId).toBe(40);
    expect(existing.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("leaves a state that lets the final step mark the thread failed when prepare dies midway", async () => {
    const failing = createFakeAdo();
    failing.on("GET", `${PR_PATH}`, () => json(pullRequest()));
    failing.on("GET", `${PR_PATH}/threads`, () => json({ value: [] }));
    failing.on("POST", `${PR_PATH}/threads`, () =>
      json({ id: 61, comments: [{ id: 1 }] }),
    );
    failing.on("GET", `${PR_PATH}/iterations`, () =>
      json({ message: "boom" }, 404),
    );
    failing.on("PATCH", `${PR_PATH}/threads/61/comments/1`, (req) =>
      json({ id: 1, ...(req.body as object) }),
    );
    const env = envFor();
    await expect(prepare(deps(env, failing))).rejects.toThrow(
      "Azure DevOps API 404",
    );
    expect(readState(env)).toMatchObject({
      shouldRunReview: true,
      trackingThreadId: 61,
    });

    await updateTracking({
      env: {
        ...env,
        DROID_SUCCESS: "false",
        DROID_ERROR_DETAILS: "azure-devops-prepare failed",
      },
      fetch: failing.fetch,
    });
    const patch = failing.requests.at(-1)!;
    expect(patch.method).toBe("PATCH");
    const content = (patch.body as { content: string }).content;
    expect(content).toContain("Droid encountered an error");
    expect(content).toContain("azure-devops-prepare failed");
  });
});

describe("validator + posting + tracking update", () => {
  it("runs the rest of the flow against the prepared state", async () => {
    const fake = fakeAdo();
    const env = envFor();
    const state = await prepare(deps(env, fake));

    fs.writeFileSync(
      state.candidatesPath!,
      JSON.stringify({ comments: [{ path: "app.ts" }] }),
    );
    await prepareValidator(env);
    expect(fs.readFileSync(state.promptPath!, "utf8")).toContain(
      state.validatedPath!,
    );

    fs.writeFileSync(
      state.validatedPath!,
      JSON.stringify({
        meta: { headSha: repo.source },
        results: [
          {
            status: "approved",
            comment: {
              path: "app.ts",
              line: 4,
              side: "RIGHT",
              body: "[P1] New line is wrong",
            },
          },
          {
            status: "approved",
            comment: {
              path: "old.ts",
              side: "LEFT",
              old_line: 1,
              body: "[P2] Removal breaks X",
            },
          },
          {
            status: "approved",
            comment: {
              path: "app.ts",
              line: 1,
              side: "RIGHT",
              body: "[P2] Context line",
            },
          },
          {
            status: "rejected",
            comment: { path: "app.ts", line: 2, body: "nope" },
          },
        ],
        reviewSummary: { body: "Found two issues." },
      }),
    );

    fake.requests.length = 0;
    const results = await postReview({ env, fetch: fake.fetch });
    expect(results).toMatchObject({
      posted: 3,
      fallbackPosted: 0,
      approved: 3,
      rejected: 1,
      failed: 0,
    });

    const posts = fake.requests
      .filter((r) => r.method === "POST")
      .map((r) => r.body as Record<string, any>);
    expect(posts[0]!.threadContext).toEqual({
      filePath: "/app.ts",
      rightFileStart: { line: 4, offset: 1 },
      rightFileEnd: { line: 4, offset: 1 },
    });
    expect(posts[0]!.pullRequestThreadContext).toEqual({
      changeTrackingId: 7,
      iterationContext: {
        firstComparingIteration: 2,
        secondComparingIteration: 2,
      },
    });
    expect(posts[1]!.threadContext.leftFileStart).toEqual({
      line: 1,
      offset: 1,
    });
    expect(posts[1]!.pullRequestThreadContext.changeTrackingId).toBe(8);

    const logPath = path.join(
      path.dirname(env.DROID_PROMPT_FILE!),
      "pass1-output.jsonl",
    );
    fs.writeFileSync(
      logPath,
      JSON.stringify({
        type: "completion",
        session_id: "sess-1",
        numTurns: 9,
        durationMs: 120000,
      }) + "\n",
    );
    fake.requests.length = 0;
    const body = await updateTracking({
      env: { ...env, DROID_SUCCESS: "true" },
      fetch: fake.fetch,
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.url).toContain(
      `/pullRequests/17/threads/${state.trackingThreadId}/comments/1`,
    );
    expect(body).toContain("Droid finished reviewing this pull request");
    expect(body).toContain("Found two issues.");
    expect(body).toContain("3 inline comments posted");
    expect(body).toContain("9 turns");
    expect(body).toContain("`sess-1`");
  });

  it("marks the build SucceededWithIssues when some approved findings fail to post", async () => {
    const ok = fakeAdo();
    // Thread POSTs 1-2 are the tracking thread and the first finding; the
    // second finding's inline and fallback attempts all fail.
    let threadPosts = 0;
    const fetch = async (url: string, init: RequestInit = {}) => {
      if (
        init.method === "POST" &&
        new URL(url).pathname.endsWith(`${PR_PATH}/threads`) &&
        ++threadPosts > 2
      ) {
        return json({ message: "rejected" }, 400);
      }
      return ok.fetch(url, init);
    };
    const env = envFor();
    const state = await prepare({ ...deps(env, ok), fetch });
    fs.writeFileSync(
      state.validatedPath!,
      JSON.stringify({
        meta: { headSha: repo.source },
        results: [
          {
            status: "approved",
            comment: { path: "app.ts", line: 4, side: "RIGHT", body: "[P1] a" },
          },
          {
            status: "approved",
            comment: { path: "app.ts", line: 2, side: "RIGHT", body: "[P1] b" },
          },
        ],
      }),
    );
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    try {
      const results = await postReview({ env, fetch });
      expect(results).toMatchObject({ posted: 1, failed: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(logs).toContain("##vso[task.complete result=SucceededWithIssues;]");
    expect(
      logs.some((l) =>
        l.startsWith(
          "##vso[task.logissue type=warning]1 of 2 approved findings could not be posted.",
        ),
      ),
    ).toBe(true);
  });

  it("posts nothing when Pass 1 left no usable candidates", async () => {
    const fake = fakeAdo();
    const env = envFor();
    const state = await prepare(deps(env, fake));
    fs.writeFileSync(state.candidatesPath!, "not json");
    await prepareValidator(env);
    expect(readState(env).validatorSkippedReason).toBeTruthy();
    fake.requests.length = 0;
    expect(await postReview({ env, fetch: fake.fetch })).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });

  it("still finalizes the tracking thread when the post results file is malformed", async () => {
    const fake = fakeAdo();
    const env = envFor();
    await prepare(deps(env, fake));
    fs.writeFileSync(postResultsFilePath(env), "{ truncated");
    fake.requests.length = 0;
    const body = await updateTracking({
      env: { ...env, DROID_SUCCESS: "true" },
      fetch: fake.fetch,
    });
    expect(fake.requests.map((r) => r.method)).toEqual(["PATCH"]);
    expect(body).toContain("Droid finished reviewing this pull request");
  });

  it("fails when Pass 2 never wrote the validated file", async () => {
    const fake = fakeAdo();
    const env = envFor();
    await prepare(deps(env, fake));
    await expect(postReview({ env, fetch: fake.fetch })).rejects.toThrow(
      "did not write",
    );
  });
});
