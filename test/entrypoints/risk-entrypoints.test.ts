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
import { run as download } from "../../src/entrypoints/risk-download";
import { run as settle } from "../../src/entrypoints/risk-settle";
import {
  checkoutWithPullRequest,
  git,
  incrementalFor,
  judge,
  planFor,
  serveWorker,
  standInWorker,
  validVerdict,
  type WorkerRun,
  type WorkerScript,
} from "../core/risk/fixtures";

type Received = { path: string; headers: Headers; body: unknown };

/** A stand-in for Factory that records each request and answers with JSON. */
function fakeFactory(answer: unknown) {
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
      return Response.json(answer);
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
  let workerPath = "";
  let outputs: Record<string, unknown> = {};
  let failed: string[] = [];
  let factory: ReturnType<typeof fakeFactory> | undefined;
  const frozen: string[] = [];

  function serve(answer: unknown) {
    factory = fakeFactory(answer);
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
      RISK_WORKER_PATH: workerPath,
      ...overrides,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-risk-entrypoint-test-"));
    planPath = join(dir, "pr-risk", "plan.json");
    resultPath = join(dir, "pr-risk", "result.json");
    workerPath = join(dir, "pr-risk", "droid-review.mjs");
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
        capabilities: ["incremental"],
        run: plan.run,
      });
      expect(outputs).toEqual({
        action: "judge",
        head_sha: plan.headSha,
        review_settle_publisher_path: expect.stringMatching(/\/settle\.mjs$/),
        review_settle_publisher_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        review_runtime_path: expect.any(String),
        review_runtime_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const settlePath = String(outputs.review_settle_publisher_path);
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

    it("keeps an earlier verdict Factory asks to re-check in the plan", async () => {
      const incremental = incrementalFor();
      serve({ action: "judge", ...assignment, incremental });

      await begin(
        jobEnv({ GITHUB_EVENT_PATH: await eventFile(pullRequestEvent) }),
      );

      frozen.push(dirname(String(outputs.review_settle_publisher_path)));
      expect(JSON.parse(await readFile(planPath, "utf8"))).toEqual({
        ...plan,
        incremental,
      });
    });

    it.each([
      [
        "the id of its record",
        { priorAssessmentId: undefined },
        "incremental.priorAssessmentId",
      ],
      [
        "the judge hash a re-check answers under",
        { judgeSha256: undefined },
        "incremental.judgeSha256",
      ],
      [
        "the decision published on it",
        { prior: { ...incrementalFor().prior, outcome: undefined } },
        "incremental.prior.outcome",
      ],
    ])(
      "plans no judge run for an earlier verdict served without %s",
      async (_name, missing, path) => {
        serve({
          action: "judge",
          ...assignment,
          incremental: { ...incrementalFor(), ...missing },
        });

        await expect(
          begin(
            jobEnv({ GITHUB_EVENT_PATH: await eventFile(pullRequestEvent) }),
          ),
        ).rejects.toThrow(`${path}: invalid_type`);
        expect(await exists(planPath)).toBe(false);
      },
    );
    it("tells Factory what the review read of the review configuration", async () => {
      const { received } = serve({ action: "skip", reason: "draft" });

      await begin(
        jobEnv({
          GITHUB_EVENT_PATH: await eventFile(pullRequestEvent),
          RISK_REVIEW_BASE_SHA: plan.baseSha,
          RISK_REVIEW_HAS_RULES: "false",
        }),
      );

      expect(received[0]?.body).toMatchObject({
        pr: 123,
        reviewConfig: { baseSha: plan.baseSha, hasRules: false },
      });
    });

    it.each([
      ["no commit", { RISK_REVIEW_HAS_RULES: "true" }],
      ["no word on the rules", { RISK_REVIEW_BASE_SHA: "b".repeat(40) }],
      [
        "a commit that is not a full SHA",
        { RISK_REVIEW_BASE_SHA: "main", RISK_REVIEW_HAS_RULES: "true" },
      ],
      [
        "a word on the rules that is not true or false",
        { RISK_REVIEW_BASE_SHA: "b".repeat(40), RISK_REVIEW_HAS_RULES: "" },
      ],
    ])(
      "says nothing of the review configuration when the review left %s",
      async (_name, said) => {
        const { received } = serve({ action: "skip", reason: "draft" });

        await begin(
          jobEnv({
            GITHUB_EVENT_PATH: await eventFile(pullRequestEvent),
            ...said,
          }),
        );

        expect(received).toHaveLength(1);
        expect(received[0]?.body).not.toHaveProperty("reviewConfig");
      },
    );

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
        capabilities: ["incremental"],
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
  });

  describe("risk-assess", () => {
    const worker = {
      version: "0.0.0",
      sdk: "0.11.0",
      droid: "9.9.9",
      tools: "denylist",
    };
    const session = (id: string, durationMs: number) => ({
      id,
      model: "test-model",
      tools: ["Read"],
      turns: 1,
      durationMs,
    });
    const failed = (reason: string, attempts?: unknown[]) => ({
      status: "failed",
      reason,
      ...(attempts ? { attempts } : {}),
      durationMs: expect.any(Number),
    });
    /** A full judgment's answer, as the worker reports one. */
    const answer = {
      verdict: validVerdict,
      judgeSha256: judge.sha256,
      snapshotHash: "f".repeat(64),
      guidelinesBlobSha: null,
      listedFiles: 1,
      durationMs: 143,
    };
    const answeredBy = (id: string) => ({
      sessions: [{ ...session(id, 47), status: "answered" }],
      status: "answered",
    });

    /**
     * A plan for the fixture pull request, and the job's checkout of its
     * repository as actions/checkout leaves it: one commit deep, with the
     * workflow token in its configuration. With `recheck`, the plan asks
     * for a re-check of the verdict on the fixture's earlier head.
     */
    async function planned(recheck?: Parameters<typeof incrementalFor>[0]) {
      const { originDir, headSha, baseSha, policySha, ...earlier } =
        await checkoutWithPullRequest(dir);
      const workspace = join(dir, "workspace");
      await git(
        dir,
        "clone",
        "-q",
        "--depth",
        "1",
        `file://${originDir}`,
        workspace,
      );
      await git(
        workspace,
        "config",
        "http.https://github.com/.extraheader",
        "AUTHORIZATION: basic d29ya2Zsb3c=",
      );
      const plan = planFor({
        headSha,
        baseSha,
        priorDeclines: [
          { headSha: "e".repeat(40), concerns: "The migration is untested." },
        ],
        ...(recheck
          ? {
              incremental: incrementalFor({
                priorHeadSha: earlier.priorHeadSha,
                priorBaseSha: earlier.priorBaseSha,
                ...recheck,
              }),
            }
          : {}),
      });
      await mkdir(join(dir, "pr-risk"));
      await writeFile(planPath, JSON.stringify(plan));
      // What every report about these commits starts with.
      const ended = {
        product: "risk",
        worker,
        input: "d".repeat(64),
        revision: { base: baseSha, head: headSha, mergeBase: baseSha },
      };
      return { plan, workspace, policySha, ended };
    }

    /**
     * Runs the step with a stand-in worker where the download step leaves
     * the real one, and returns what each left. `left` is what the step
     * finds there: the worker it runs, that worker with a line added, or
     * no file.
     */
    async function assessWith(
      workspace: string,
      script: Omit<WorkerScript, "recordPath">,
      left: "worker" | "changed" | "nothing" = "worker",
    ): Promise<{ result: unknown; ran: WorkerRun | undefined }> {
      const recordPath = join(dir, "worker-run.json");
      const { source, sha256 } = standInWorker({ ...script, recordPath });
      if (left !== "nothing") {
        await writeFile(
          workerPath,
          left === "worker" ? source : `${source}// changed\n`,
        );
      }
      await assess(
        jobEnv({
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          GITHUB_WORKSPACE: workspace,
          GH_TOKEN: "read-token",
          GITHUB_TOKEN: "workflow-token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
          RISK_JUDGE_API_BASE_URL: "https://judge.example",
        }),
        sha256,
      );
      return {
        result: JSON.parse(await readFile(resultPath, "utf8")),
        ran: (await exists(recordPath))
          ? JSON.parse(await readFile(recordPath, "utf8"))
          : undefined,
      };
    }

    it("leaves a failed result when the plan cannot be read", async () => {
      await assess(jobEnv({ GITHUB_WORKSPACE: dir }));

      expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
        result: {
          status: "failed",
          reason: "plan_unreadable",
          durationMs: expect.any(Number),
        },
      });
    });

    it("leaves a failed result, and nothing else, when it has no token to read GitHub with", async () => {
      const plan = planFor();
      await mkdir(join(dir, "pr-risk"));
      await writeFile(planPath, JSON.stringify(plan));

      await assess(jobEnv({ GITHUB_WORKSPACE: dir }));

      expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
        result: {
          status: "failed",
          reason: "github_token_missing",
          durationMs: expect.any(Number),
        },
      });
      expect((await stat(resultPath)).mode % 0o1000).toBe(0o600);
    });

    it("does not read GitHub with a GITHUB_TOKEN the job happens to hold", async () => {
      // A real run whose read-only token could not be minted: the action
      // passes an empty GH_TOKEN, and the job exports its own token.
      const plan = planFor();
      await mkdir(join(dir, "pr-risk"));
      await writeFile(
        planPath,
        JSON.stringify({ ...plan, run: { ...plan.run, dryRun: false } }),
      );

      await assess(
        jobEnv({
          GITHUB_WORKSPACE: dir,
          RISK_DRY_RUN: "false",
          GH_TOKEN: "",
          GITHUB_TOKEN: "workflow-token",
        }),
      );

      expect(JSON.parse(await readFile(resultPath, "utf8"))).toMatchObject({
        result: { status: "failed", reason: "github_token_missing" },
      });
    });

    it("runs the worker on the planned commits with the judge's credentials and nothing else of the job, and settles its answer", async () => {
      const { plan, workspace, policySha, ended } = await planned();

      const { result, ran } = await assessWith(workspace, {
        exitCode: 0,
        report: {
          ...ended,
          // An answer that broke the contract, then one that kept it.
          sessions: [
            {
              ...session("session-0", 54),
              status: "invalid",
              issues: [
                { path: ["scores", "blastRadius"], code: "too_big" },
                { path: [], code: "invalid_type" },
                { path: ["scores", "blastRadius"], code: "invalid_type" },
              ],
            },
            { ...session("session-1", 47), status: "answered" },
          ],
          status: "answered",
          answer,
        },
      });

      expect(ran?.args).toEqual([
        "risk",
        "--repo",
        workspace,
        "--input",
        expect.any(String),
        "--report",
        expect.any(String),
      ]);
      expect(ran?.input).toEqual({
        repo: "acme/app",
        pr: 123,
        title: "Rotate sessions safely",
        base: plan.baseSha,
        head: plan.headSha,
        // The default branch's tip, which the pull request cannot move.
        policy: policySha,
        priorDeclines: plan.priorDeclines,
        judge,
      });
      expect(ran?.env).toEqual({
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DROID_BIN: "droid",
        FACTORY_API_KEY: "factory-key",
        GH_TOKEN: "read-token",
        FACTORY_API_BASE_URL: "https://judge.example",
      });
      // The checkout held no credential by the time the worker started, and
      // held the history a merge base needs.
      expect(ran?.repoConfig).not.toContain("extraheader");
      expect(
        await git(workspace, "merge-base", plan.baseSha, plan.headSha),
      ).toMatch(/^[0-9a-f]{40}$/);
      // The worker, its input and its report are gone.
      expect(await exists(String(ran?.cwd))).toBe(false);
      expect(result).toEqual({
        droidCliVersion: "9.9.9",
        result: {
          status: "judged",
          baseSha: plan.baseSha,
          ...answer,
          attempts: [
            {
              sessionId: "session-0",
              valid: false,
              durationMs: 54,
              invalidReason: "schema",
              invalidPaths: ["scores.blastRadius", "<root>"],
              invalidCodes: ["too_big", "invalid_type"],
              retryFeedback: [
                "scores.blastRadius: too_big",
                "<root>: invalid_type",
                "scores.blastRadius: invalid_type",
              ],
            },
            { sessionId: "session-1", valid: true, durationMs: 47 },
          ],
        },
      });
    }, 30_000);

    it("hands the worker an earlier verdict to re-check, with its commits fetched, and settles the re-check it reports", async () => {
      const { plan, workspace, ended } = await planned({ mode: "enforce" });
      const incremental = plan.incremental!;
      const recheck = {
        ...answer,
        verdict: {
          ...validVerdict,
          resolvedConcerns: [{ concern: "c1", evidence: "rotate.test.ts" }],
          checks: [
            { command: "~/rotate.sh", exitCode: 0, covers: ["feature.ts"] },
            { command: "bun test", exitCode: 0, covers: ["feature.ts"] },
          ],
        },
        judgeSha256: incremental.judgeSha256,
        mode: "incremental",
        priorHeadSha: incremental.priorHeadSha,
        priorAssessmentId: incremental.priorAssessmentId,
        checkRuns: [
          { index: 0, outcome: "rejected", reason: "home_path" },
          { index: 1, outcome: "ran", exitCode: 0, durationMs: 812 },
        ],
      };

      const { result, ran } = await assessWith(workspace, {
        exitCode: 0,
        report: { ...ended, ...answeredBy("session-0"), answer: recheck },
      });

      expect(ran?.input).toMatchObject({ head: plan.headSha, incremental });
      for (const sha of [incremental.priorBaseSha, incremental.priorHeadSha]) {
        expect(await git(workspace, "cat-file", "-t", sha)).toBe("commit");
      }
      expect(result).toEqual({
        droidCliVersion: "9.9.9",
        result: {
          status: "judged",
          baseSha: plan.baseSha,
          ...recheck,
          attempts: [{ sessionId: "session-0", valid: true, durationMs: 47 }],
        },
      });
    }, 30_000);

    it("still runs the worker when the remote has lost the earlier verdict's commits, and settles the full judgment with why", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const { plan, workspace, ended } = await planned({
        priorHeadSha: "1".repeat(40),
      });
      const incremental = plan.incremental!;
      const afresh = {
        ...answer,
        mode: "full",
        incrementalFallback: "evidence_git_failed",
        priorHeadSha: incremental.priorHeadSha,
        priorAssessmentId: incremental.priorAssessmentId,
      };

      const { result, ran } = await assessWith(workspace, {
        exitCode: 0,
        report: { ...ended, ...answeredBy("session-0"), answer: afresh },
      });

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "The earlier verdict's commits could not be fetched",
        ),
      );
      expect(ran?.input).toMatchObject({ incremental });
      expect(result).toEqual({
        droidCliVersion: "9.9.9",
        result: {
          status: "judged",
          baseSha: plan.baseSha,
          ...afresh,
          attempts: [{ sessionId: "session-0", valid: true, durationMs: 47 }],
        },
      });
    }, 30_000);

    it("settles a re-check the worker ran beside the judgment as the shadow, with its own sessions", async () => {
      const { plan, workspace, ended } = await planned({ mode: "shadow" });
      const incremental = plan.incremental!;
      const recheck = {
        ...answer,
        snapshotHash: "5".repeat(64),
        judgeSha256: incremental.judgeSha256,
        durationMs: 151,
        mode: "incremental",
        priorHeadSha: incremental.priorHeadSha,
        priorAssessmentId: incremental.priorAssessmentId,
      };

      const { result } = await assessWith(workspace, {
        exitCode: 0,
        report: {
          ...ended,
          ...answeredBy("session-0"),
          answer,
          shadow: {
            sessions: [
              {
                ...session("session-1", 54),
                status: "invalid",
                issues: [{ path: ["checks", 0, "command"], code: "too_big" }],
              },
              { ...session("session-2", 61), status: "answered" },
            ],
            status: "answered",
            answer: recheck,
          },
        },
      });

      expect(result).toEqual({
        droidCliVersion: "9.9.9",
        result: {
          status: "judged",
          baseSha: plan.baseSha,
          ...answer,
          attempts: [{ sessionId: "session-0", valid: true, durationMs: 47 }],
        },
        shadow: {
          status: "judged",
          baseSha: plan.baseSha,
          ...recheck,
          attempts: [
            {
              sessionId: "session-1",
              valid: false,
              durationMs: 54,
              invalidReason: "schema",
              invalidPaths: ["checks.0.command"],
              invalidCodes: ["too_big"],
              retryFeedback: ["checks.0.command: too_big"],
            },
            { sessionId: "session-2", valid: true, durationMs: 61 },
          ],
        },
      });
    }, 30_000);

    it("settles a shadow that answered beside a judgment that did not", async () => {
      const { plan, workspace, ended } = await planned({ mode: "shadow" });

      const { result } = await assessWith(workspace, {
        exitCode: 1,
        report: {
          ...ended,
          sessions: [{ status: "failed", problem: "start" }],
          status: "failed",
          problem: "start",
          shadow: { ...answeredBy("session-1"), answer },
        },
      });

      expect(result).toEqual({
        droidCliVersion: "9.9.9",
        result: failed("judge_exec_failed"),
        shadow: {
          status: "judged",
          baseSha: plan.baseSha,
          ...answer,
          attempts: [{ sessionId: "session-1", valid: true, durationMs: 47 }],
        },
      });
    }, 30_000);

    /** Each way a judgment ends without an answer, and what Factory is told. */
    const unanswered: [string, object, string, unknown[] | undefined][] = [
      [
        "never started a session",
        {
          sessions: [{ status: "failed", problem: "start" }],
          status: "failed",
          problem: "start",
        },
        "judge_exec_failed",
        undefined,
      ],
      [
        "lost its session",
        {
          sessions: [
            {
              ...session("session-0", 47),
              status: "failed",
              problem: "execution",
            },
          ],
          status: "failed",
          problem: "execution",
        },
        "judge_exec_failed",
        [{ sessionId: "session-0", valid: false, durationMs: 47 }],
      ],
      [
        "ran out of time",
        {
          sessions: [
            {
              ...session("session-0", 1009),
              status: "interrupted",
              by: "deadline",
            },
          ],
          status: "interrupted",
          by: "deadline",
        },
        "judge_timeout",
        [{ sessionId: "session-0", valid: false, durationMs: 1009 }],
      ],
      [
        "was told to stop",
        {
          sessions: [
            {
              ...session("session-0", 99),
              status: "interrupted",
              by: "signal",
            },
          ],
          status: "interrupted",
          by: "signal",
        },
        "judge_interrupted",
        [{ sessionId: "session-0", valid: false, durationMs: 99 }],
      ],
      [
        "got two answers that broke the contract",
        {
          sessions: [
            {
              ...session("session-0", 43),
              status: "invalid",
              issues: [{ path: ["scores", "blastRadius"], code: "too_big" }],
            },
            {
              ...session("session-1", 34),
              status: "invalid",
              issues: [
                { path: ["verdict"], code: "invalid_type" },
                { path: ["brief"], code: "invalid_type" },
              ],
            },
          ],
          status: "invalid",
        },
        "invalid_pr_risk_verdict",
        [
          {
            sessionId: "session-0",
            valid: false,
            durationMs: 43,
            invalidReason: "schema",
            invalidPaths: ["scores.blastRadius"],
            invalidCodes: ["too_big"],
            retryFeedback: ["scores.blastRadius: too_big"],
          },
          {
            sessionId: "session-1",
            valid: false,
            durationMs: 34,
            invalidReason: "schema",
            invalidPaths: ["verdict", "brief"],
            invalidCodes: ["invalid_type"],
            retryFeedback: ["verdict: invalid_type", "brief: invalid_type"],
          },
        ],
      ],
    ];

    it.each(unanswered)(
      "reports a worker that %s as a failed judgment",
      async (_ending, report, reason, attempts) => {
        const { workspace, ended } = await planned();

        const { result } = await assessWith(workspace, {
          exitCode: 1,
          report: { ...ended, ...report },
        });

        expect(result).toEqual({
          droidCliVersion: "9.9.9",
          result: failed(reason, attempts),
        });
      },
      30_000,
    );

    it.each(unanswered)(
      "reports a shadow that %s as a failed shadow, beside the judgment it ran with",
      async (_ending, shadow, reason, attempts) => {
        const { plan, workspace, ended } = await planned({ mode: "shadow" });

        const { result } = await assessWith(workspace, {
          exitCode: 0,
          report: { ...ended, ...answeredBy("session-9"), answer, shadow },
        });

        expect(result).toEqual({
          droidCliVersion: "9.9.9",
          result: {
            status: "judged",
            baseSha: plan.baseSha,
            ...answer,
            attempts: [{ sessionId: "session-9", valid: true, durationMs: 47 }],
          },
          shadow: failed(reason, attempts),
        });
      },
      30_000,
    );

    it("settles commits the worker could not pin as a git failure", async () => {
      const { workspace } = await planned();

      const { result } = await assessWith(workspace, {
        exitCode: 1,
        // A report from before any commit was pinned names no revision.
        report: {
          product: "risk",
          worker,
          input: "d".repeat(64),
          status: "unpinned",
          problem: { kind: "unresolved", ref: "no-such-branch" },
        },
      });

      expect(result).toEqual({
        droidCliVersion: "9.9.9",
        result: failed("evidence_git_failed"),
      });
    }, 30_000);

    it("trusts no report from a worker that says it left none, and logs why it stopped", async () => {
      const warning = spyOn(core, "warning").mockImplementation(() => {});
      const { workspace, ended } = await planned();

      const { result } = await assessWith(workspace, {
        exitCode: 2,
        stderr: "droid-review: input.judge.settings is not a judge\n",
        report: { ...ended, ...answeredBy("session-0"), answer },
      });

      expect(result).toEqual({
        result: {
          status: "failed",
          reason: "worker_no_report",
          durationMs: expect.any(Number),
        },
      });
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(
          "(exit 2): droid-review: input.judge.settings is not a judge",
        ),
      );
    }, 30_000);

    it.each<
      [string, (ended: { revision: object }) => object | undefined, string]
    >([
      ...(["head", "base"] as const).map(
        (side): [string, (ended: { revision: object }) => object, string] => [
          `answers about a ${side} that was not planned`,
          (ended) => ({
            ...ended,
            revision: { ...ended.revision, [side]: "e".repeat(40) },
            ...answeredBy("session-0"),
            answer,
          }),
          "is not about the planned commits",
        ],
      ),
      [
        "claims an answer and holds none",
        (ended: object) => ({ ...ended, ...answeredBy("session-0") }),
        // What is wrong with it, and nothing it holds.
        "was not understood (answer: invalid_type)",
      ],
      [
        "holds an answer no session gave",
        (ended: object) => ({
          ...ended,
          sessions: [{ status: "failed", problem: "start" }],
          status: "answered",
          answer,
        }),
        "holds an answer no session gave",
      ],
      ["was never written", () => undefined, "could not be read"],
    ])(
      "settles no verdict from a report that %s",
      async (_problem, report, logged) => {
        const warning = spyOn(core, "warning").mockImplementation(() => {});
        const { workspace, ended } = await planned();

        const { result } = await assessWith(workspace, {
          exitCode: 0,
          report: report(ended),
        });

        expect(result).toMatchObject({
          result: { status: "failed", reason: "worker_report_unreadable" },
        });
        expect(warning).toHaveBeenCalledWith(expect.stringContaining(logged));
      },
      30_000,
    );

    it.each([
      [
        "a worker whose bytes are not the ones this version runs",
        "changed",
        "bytes are not the ones this version runs",
      ],
      [
        "anything when the download step left no worker",
        "nothing",
        "left no PR risk worker to run",
      ],
    ] as const)(
      "does not run %s, and settles no verdict",
      async (_refused, left, logged) => {
        const warning = spyOn(core, "warning").mockImplementation(() => {});
        const { workspace, ended } = await planned();

        // A worker that would answer, were it run.
        const { result, ran } = await assessWith(
          workspace,
          {
            exitCode: 0,
            report: { ...ended, ...answeredBy("session-0"), answer },
          },
          left,
        );

        expect(ran).toBeUndefined();
        expect(result).toEqual({
          result: {
            status: "failed",
            reason: "worker_unavailable",
            durationMs: expect.any(Number),
          },
        });
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining(logged));
      },
      30_000,
    );
  });

  describe("risk-download", () => {
    const source = "console.log('a stand-in for the worker');\n";
    let served: ReturnType<typeof serveWorker> | undefined;
    let logged: string[] = [];

    beforeEach(() => {
      served = serveWorker(source);
      logged = [];
      const keep = (...parts: unknown[]) => {
        logged.push(parts.join(" "));
      };
      spyOn(core, "warning").mockImplementation(keep);
      spyOn(console, "log").mockImplementation(keep);
      spyOn(console, "error").mockImplementation(keep);
    });

    afterEach(async () => {
      await served?.stop();
    });

    it("leaves the worker in a file only the job's user can read, and sends the token no further than the address that asks for it", async () => {
      await download(jobEnv({ RISK_WORKER_TOKEN: served!.token }), served!.url);

      expect(await readFile(workerPath, "utf8")).toBe(source);
      expect((await stat(workerPath)).mode % 0o1000).toBe(0o600);
      expect((await stat(dirname(workerPath))).mode % 0o1000).toBe(0o700);
      // GitHub's API redirects the download to storage on another host.
      expect(served!.forwarded).toEqual([]);
      expect(core.warning).not.toHaveBeenCalled();
      expect(logged.join("\n")).not.toContain(served!.token);
    });

    it.each([
      ["it has no token", " ", "(RISK_WORKER_TOKEN is empty)"],
      [
        "its token cannot read the worker",
        "a-token-that-cannot-read-it",
        "(status 404)",
      ],
    ])(
      "leaves no worker when %s, and says why without quoting a token",
      async (_refused, token, why) => {
        // Resolves: a failed download is the assess step's to report.
        await download(jobEnv({ RISK_WORKER_TOKEN: token }), served!.url);

        expect(await exists(workerPath)).toBe(false);
        expect(core.warning).toHaveBeenCalledTimes(1);
        expect(core.warning).toHaveBeenCalledWith(expect.stringContaining(why));
        expect(logged.join("\n")).not.toContain("token-that");
      },
    );
  });

  describe("risk-settle", () => {
    const plan = planFor();
    const judged = {
      droidCliVersion: "1.2.3",
      result: {
        status: "judged",
        baseSha: plan.baseSha,
        judgeSha256: judge.sha256,
        snapshotHash: "f".repeat(64),
        guidelinesBlobSha: null,
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

    it.each([
      [
        "an enforced re-check as the result",
        {
          result: {
            ...judged.result,
            mode: "incremental",
            priorHeadSha: "1".repeat(40),
            priorAssessmentId: "0b9f6f0e-4c1d-4a55-9d2e-6a1f0c3b7e21",
            checkRuns: [
              { index: 0, outcome: "rejected", reason: "home_path" },
              { index: 1, outcome: "ran", exitCode: 0, durationMs: 812 },
            ],
          },
        },
      ],
      [
        "a full judgment that fell back from a re-check, and a shadow beside it",
        {
          result: {
            ...judged.result,
            mode: "full",
            incrementalFallback: "pr_risk_incremental_too_wide",
            priorHeadSha: "1".repeat(40),
            priorAssessmentId: "0b9f6f0e-4c1d-4a55-9d2e-6a1f0c3b7e21",
          },
          shadow: { status: "failed", reason: "judge_timeout", durationMs: 9 },
        },
      ],
    ])("hands Factory %s", async (_what, left) => {
      const { received } = serve({ status: "published", outcome: "approve" });
      await writeFile(resultPath, JSON.stringify(left));

      await settle(jobEnv());

      expect(received[0]?.body).toEqual({
        repo: "acme/app",
        pr: 123,
        headSha: plan.headSha,
        run: plan.run,
        ...left,
      });
    });

    it("settles a run that left no result as a failure, and fails the step", async () => {
      const { received } = serve({
        status: "published",
        outcome: "unavailable",
      });

      await settle(jobEnv());

      expect(received[0]?.body).toEqual({
        repo: "acme/app",
        pr: 123,
        headSha: plan.headSha,
        run: plan.run,
        result: { status: "failed", reason: "runner_died" },
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
    it("passes with a notice when Factory takes the report and publishes nothing", async () => {
      const notice = spyOn(core, "notice").mockImplementation(() => {});
      serve({ status: "skipped", reason: "not_enabled" });

      await settle(jobEnv());

      expect(outputs).toEqual({ outcome: "skipped" });
      expect(failed).toEqual([]);
      expect(notice).toHaveBeenCalledWith(
        `Factory published nothing for ${plan.headSha} (not_enabled).`,
      );
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
