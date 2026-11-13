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
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run as assess } from "../../src/entrypoints/risk-assess";
import { run as begin } from "../../src/entrypoints/risk-begin";
import { run as settle } from "../../src/entrypoints/risk-settle";
import {
  createRepushedPullRequest,
  judge,
  planFor,
  validVerdict,
} from "../core/risk/fixtures";

type Received = { path: string; headers: Headers; body: unknown };

/**
 * A stand-in for Factory that records each request and answers with JSON:
 * the nth request gets the nth answer, and any request after that the last.
 */
function fakeFactory(answers: unknown[]) {
  const received: Received[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.json(),
      });
      return Response.json(
        answers[Math.min(received.length, answers.length) - 1],
      );
    },
  });
  return {
    received,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("risk action entrypoints", () => {
  let dir = "";
  let planPath = "";
  let resultPath = "";
  let outputs: Record<string, unknown> = {};
  let failed: string[] = [];
  let factory: ReturnType<typeof fakeFactory> | undefined;
  const frozen: string[] = [];

  function serve(...answers: unknown[]) {
    factory = fakeFactory(answers);
    return factory;
  }

  async function eventFile(event: unknown): Promise<string> {
    const path = join(dir, "event.json");
    await writeFile(path, JSON.stringify(event));
    return path;
  }

  function jobEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_RUN_ID: "77",
      GITHUB_RUN_ATTEMPT: "2",
      FACTORY_API_KEY: "factory-key",
      RISK_API_BASE_URL: factory?.url,
      RISK_DRY_RUN: "true",
      RISK_PLAN_PATH: planPath,
      RISK_RESULT_PATH: resultPath,
      ...overrides,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-risk-entrypoint-test-"));
    planPath = join(dir, "pr-risk", "plan.json");
    resultPath = join(dir, "pr-risk", "result.json");
    outputs = {};
    failed = [];
    spyOn(core, "setOutput").mockImplementation((name, value) => {
      outputs[name] = value;
    });
    spyOn(core, "setFailed").mockImplementation((message) => {
      failed.push(String(message));
    });
    spyOn(core, "notice").mockImplementation(() => {});
    spyOn(core, "warning").mockImplementation(() => {});
  });

  afterEach(async () => {
    mock.restore();
    await factory?.stop();
    factory = undefined;
    for (const path of [dir, ...frozen.splice(0)]) {
      await rm(path, { recursive: true, force: true });
    }
  });

  describe("risk-begin", () => {
    const plan = planFor();
    const assignment = {
      headSha: plan.headSha,
      baseSha: plan.baseSha,
      pullRequest: plan.pullRequest,
      priorDeclines: plan.priorDeclines,
      judge,
    };
    const pullRequestEvent = {
      pull_request: { number: 123, head: { sha: plan.headSha } },
    };

    it("tells Factory about the run and keeps what it serves in an owner-only plan", async () => {
      const { received } = serve({ action: "judge", ...assignment });

      await begin(
        jobEnv({
          GITHUB_EVENT_PATH: await eventFile(pullRequestEvent),
          RISK_REVIEW_OUTCOME: "success",
          RISK_MANUAL: "false",
        }),
      );

      expect(received).toHaveLength(1);
      expect(received[0]?.path).toBe("/api/internal/pr-risk/begin");
      expect(received[0]?.headers.get("authorization")).toBe(
        "Bearer factory-key",
      );
      expect(received[0]?.headers.has("x-github-oidc-token")).toBe(false);
      expect(received[0]?.body).toEqual({
        repo: "acme/app",
        pr: 123,
        eventHeadSha: plan.headSha,
        manual: false,
        reviewOutcome: "success",
        keep: {},
        run: plan.run,
      });
      expect(outputs).toEqual({
        action: "judge",
        head_sha: plan.headSha,
        settle_path: expect.stringMatching(/\/settle\.mjs$/),
        settle_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        runtime_path: expect.any(String),
        runtime_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const settlePath = String(outputs.settle_path);
      frozen.push(dirname(settlePath));
      // Outside the checkout, so nothing the judge does to the action's files
      // reaches the copy the settle step runs.
      expect(settlePath.startsWith(join(import.meta.dir, "..", ".."))).toBe(
        false,
      );
      expect((await stat(settlePath)).mode % 0o1000).toBe(0o600);
      expect(JSON.parse(await readFile(planPath, "utf8"))).toEqual(plan);
      expect((await stat(planPath)).mode % 0o1000).toBe(0o600);
    });

    it("tells Factory when the event saw a draft", async () => {
      const { received } = serve({ action: "skip", reason: "draft" });

      await begin(
        jobEnv({
          GITHUB_EVENT_PATH: await eventFile({
            pull_request: { ...pullRequestEvent.pull_request, draft: true },
          }),
        }),
      );

      expect(received[0]?.body).toMatchObject({ pr: 123, eventDraft: true });
    });

    it("writes no plan for a skip, and clears what an earlier use of the action left", async () => {
      serve({ action: "skip", reason: "nothing_to_assess" });
      await mkdir(join(dir, "pr-risk"));
      await writeFile(planPath, JSON.stringify(plan));
      await writeFile(resultPath, "{}");

      await begin(
        jobEnv({ GITHUB_EVENT_PATH: await eventFile(pullRequestEvent) }),
      );

      expect(outputs).toEqual({ action: "skip" });
      expect(await exists(planPath)).toBe(false);
      expect(await exists(resultPath)).toBe(false);
    });

    it("judges nothing when Factory asks for something this version does not know", async () => {
      serve({ action: "an_action_added_later", ...assignment });

      await begin(
        jobEnv({ GITHUB_EVENT_PATH: await eventFile(pullRequestEvent) }),
      );

      expect(outputs).toEqual({ action: "skip" });
      expect(await exists(planPath)).toBe(false);
      expect(failed).toEqual([]);
    });
    it("reports the head of a hold without planning a judge run", async () => {
      serve({
        action: "hold",
        reason: "waiting_for_review",
        headSha: plan.headSha,
      });

      await begin(
        jobEnv({ GITHUB_EVENT_PATH: await eventFile(pullRequestEvent) }),
      );

      expect(outputs).toEqual({ action: "hold", head_sha: plan.headSha });
      expect(await exists(planPath)).toBe(false);
    });

    it("asks for the dispatched pull request as an explicit request", async () => {
      const { received } = serve({
        action: "skip",
        reason: "nothing_to_assess",
      });

      await begin(
        jobEnv({
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_EVENT_PATH: await eventFile({ inputs: {} }),
          RISK_PR_NUMBER: "456",
          RISK_MANUAL: "true",
        }),
      );

      expect(received[0]?.body).toEqual({
        repo: "acme/app",
        pr: 456,
        manual: true,
        keep: {},
        run: { ...plan.run, trigger: "workflow_dispatch" },
      });
    });

    it("asks nothing when the event has no pull request", async () => {
      const { received } = serve({ action: "judge", ...assignment });

      await begin(
        jobEnv({
          GITHUB_EVENT_PATH: await eventFile({ ref: "refs/heads/dev" }),
        }),
      );

      expect(received).toEqual([]);
      expect(outputs).toEqual({ action: "skip" });
    });

    it("sends nothing from a real run that cannot prove which workflow it is", async () => {
      const { received } = serve({ action: "judge", ...assignment });

      await expect(
        begin(
          jobEnv({
            GITHUB_EVENT_PATH: await eventFile(pullRequestEvent),
            RISK_DRY_RUN: "false",
          }),
        ),
      ).rejects.toMatchObject({ reason: "oidc_unavailable" });

      expect(received).toEqual([]);
      expect(await exists(planPath)).toBe(false);
    });

    describe("when Factory offers to keep a verdict", () => {
      const begun = {
        repo: "acme/app",
        pr: 123,
        eventHeadSha: plan.headSha,
        manual: false,
        run: plan.run,
      };

      it("answers with what changed since the approved head, and judges nothing once Factory keeps it", async () => {
        const { checkoutDir, scoredHeadSha, headSha } =
          await createRepushedPullRequest(dir);
        const { received } = serve(
          { action: "keep", headSha, scoredHeadSha },
          { action: "skip", reason: "verdict_kept" },
        );

        await begin(
          jobEnv({
            GITHUB_EVENT_PATH: await eventFile(pullRequestEvent),
            GITHUB_WORKSPACE: checkoutDir,
          }),
        );

        expect(received.map((request) => request.path)).toEqual([
          "/api/internal/pr-risk/begin",
          "/api/internal/pr-risk/begin",
        ]);
        expect(received[0]?.body).toEqual({ ...begun, keep: {} });
        expect(received[1]?.body).toEqual({
          ...begun,
          keep: {
            changes: {
              headSha,
              scoredHeadSha,
              diff: expect.stringContaining("-const b = 2;\n+const b = 3;\n"),
            },
          },
        });
        expect(outputs).toEqual({ action: "skip" });
        expect(await exists(planPath)).toBe(false);
        expect(core.notice).toHaveBeenCalledWith(
          expect.stringContaining("Factory kept its approval of #123"),
        );
        expect(failed).toEqual([]);
      });

      it("asks again without changes when the job has no checkout, and judges the head Factory then assigns", async () => {
        const { received } = serve(
          {
            action: "keep",
            headSha: plan.headSha,
            scoredHeadSha: "d".repeat(40),
          },
          { action: "judge", ...assignment },
        );

        await begin(
          jobEnv({ GITHUB_EVENT_PATH: await eventFile(pullRequestEvent) }),
        );

        expect(received).toHaveLength(2);
        expect(received[1]?.body).toEqual(begun);
        expect(outputs).toMatchObject({
          action: "judge",
          head_sha: plan.headSha,
        });
        frozen.push(dirname(String(outputs.settle_path)));
        expect(JSON.parse(await readFile(planPath, "utf8"))).toEqual(plan);
      });

      it("fails when Factory offers again instead of deciding", async () => {
        const { received } = serve({
          action: "keep",
          headSha: plan.headSha,
          scoredHeadSha: "d".repeat(40),
        });

        await expect(
          begin(
            jobEnv({ GITHUB_EVENT_PATH: await eventFile(pullRequestEvent) }),
          ),
        ).rejects.toMatchObject({ reason: "keep_offer_repeated" });

        expect(received).toHaveLength(2);
        expect(outputs).toEqual({});
        expect(await exists(planPath)).toBe(false);
      });
    });
  });

  describe("risk-assess", () => {
    it("leaves a failed result when the plan cannot be read", async () => {
      await assess([], jobEnv({ GITHUB_WORKSPACE: dir }));

      expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
        result: { status: "failed", reason: "plan_unreadable" },
      });
    });

    it("leaves a failed result naming the head when it has no token to read GitHub with", async () => {
      const plan = planFor();
      await mkdir(join(dir, "pr-risk"));
      await writeFile(planPath, JSON.stringify(plan));

      await assess(
        [],
        jobEnv({
          GITHUB_WORKSPACE: dir,
          DROID_BIN: join(dir, "no-such-droid"),
        }),
      );

      expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
        headSha: plan.headSha,
        result: {
          status: "failed",
          reason: "github_token_missing",
          judgeSha256: judge.sha256,
          durationMs: expect.any(Number),
        },
      });
      expect((await stat(resultPath)).mode % 0o1000).toBe(0o600);
    });

    it("rejects an offline run that does not say what to judge", async () => {
      await expect(
        assess(["--repo", "acme/app"], jobEnv()),
      ).rejects.toMatchObject({ reason: "usage" });
      expect(await exists(resultPath)).toBe(false);
    });
  });

  describe("risk-settle", () => {
    const plan = planFor();
    const judged = {
      headSha: plan.headSha,
      droidCliVersion: "1.2.3",
      result: {
        status: "judged",
        baseSha: plan.baseSha,
        judgeSha256: judge.sha256,
        snapshotHash: "f".repeat(64),
        listedFiles: 1,
        attempts: [{ sessionId: "s1", valid: true, durationMs: 12 }],
        durationMs: 34,
        verdict: validVerdict,
      },
    };

    beforeEach(async () => {
      await mkdir(join(dir, "pr-risk"));
      await writeFile(planPath, JSON.stringify(plan));
    });

    it("hands Factory the judged head and reports the outcome it published", async () => {
      const { received } = serve({
        status: "published",
        outcome: "approve",
        publication: {
          comment: { action: "created" },
          approval: { action: "approved" },
        },
      });
      await writeFile(resultPath, JSON.stringify(judged));

      await settle(jobEnv());

      expect(received).toHaveLength(1);
      expect(received[0]?.path).toBe("/api/internal/pr-risk/settle");
      expect(received[0]?.headers.get("authorization")).toBe(
        "Bearer factory-key",
      );
      expect(received[0]?.body).toEqual({
        repo: "acme/app",
        pr: 123,
        headSha: plan.headSha,
        run: { ...plan.run, droidCliVersion: "1.2.3" },
        result: judged.result,
      });
      expect(outputs).toEqual({ outcome: "approve" });
      expect(failed).toEqual([]);
    });

    it("settles a run that left no result as a failure, and fails the step", async () => {
      const { received } = serve({
        status: "published",
        outcome: "unavailable",
      });

      await settle(jobEnv());

      expect(received[0]?.body).toMatchObject({
        headSha: plan.headSha,
        result: {
          status: "failed",
          reason: "runner_died",
          judgeSha256: judge.sha256,
        },
      });
      expect(outputs).toEqual({ outcome: "unavailable" });
      expect(failed).toEqual([
        `PR risk assessment is unavailable for ${plan.headSha} (runner_died).`,
      ]);
    });

    it("leaves a head that moved on to the run for the newer head", async () => {
      serve({ status: "stale_head", headSha: "e".repeat(40) });
      await writeFile(resultPath, JSON.stringify(judged));

      await settle(jobEnv());

      expect(outputs).toEqual({ outcome: "stale_head" });
      expect(failed).toEqual([]);
    });
    it("claims no outcome when Factory answers with a status this version does not know", async () => {
      serve({ status: "a_status_added_later", outcome: "approve" });
      await writeFile(resultPath, JSON.stringify(judged));

      await settle(jobEnv());

      expect(outputs).toEqual({ outcome: "unknown" });
      expect(failed).toEqual([]);
    });
  });
});
