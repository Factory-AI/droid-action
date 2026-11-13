import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRiskRun,
  buildSettleRequest,
  describeFailure,
  parseFlag,
  parseReviewOutcome,
  readRiskPlan,
  readRiskResult,
  resolveTarget,
  riskPlanPath,
  riskResultPath,
  writePrivateJson,
} from "../../../src/core/risk/plan";
import {
  RiskError,
  failureReason,
  type RiskResultFile,
} from "../../../src/core/risk/types";
import { judge, planFor, validVerdict } from "./fixtures";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "e".repeat(40);

describe("resolveTarget", () => {
  it("takes the pull request and head from a pull_request event", () => {
    expect(
      resolveTarget("", { pull_request: { number: 7, head: { sha: HEAD } } }),
    ).toEqual({ pr: 7, eventHeadSha: HEAD });
  });

  it("takes them from the run a workflow_run event reports on", () => {
    expect(
      resolveTarget(undefined, {
        workflow_run: { head_sha: HEAD, pull_requests: [{ number: 9 }] },
      }),
    ).toEqual({ pr: 9, eventHeadSha: HEAD });
    expect(
      resolveTarget(undefined, {
        workflow_run: {
          head_sha: HEAD,
          pull_requests: [{ number: 9, head: { sha: OTHER_HEAD } }],
        },
      }),
    ).toEqual({ pr: 9, eventHeadSha: OTHER_HEAD });
  });

  it("lets an explicit number win, and reports the event's head only for that same pull request", () => {
    const event = { pull_request: { number: 7, head: { sha: HEAD } } };

    expect(resolveTarget("7", event)).toEqual({ pr: 7, eventHeadSha: HEAD });
    expect(resolveTarget(" 12 ", event)).toEqual({ pr: 12 });
  });

  it("reports a draft only when the event about that pull request saw one", () => {
    const draft = {
      pull_request: { number: 7, head: { sha: HEAD }, draft: true },
    };

    expect(resolveTarget("", draft)).toEqual({
      pr: 7,
      eventHeadSha: HEAD,
      eventDraft: true,
    });
    expect(resolveTarget("12", draft)).toEqual({ pr: 12 });
    expect(
      resolveTarget("", {
        pull_request: { number: 7, head: { sha: HEAD }, draft: false },
      }),
    ).toEqual({ pr: 7, eventHeadSha: HEAD });
  });

  it("reads the number a manual run was dispatched with", () => {
    expect(resolveTarget("", { inputs: { pr_number: "31" } })).toEqual({
      pr: 31,
    });
  });

  it("drops a head that is not a full commit SHA", () => {
    expect(
      resolveTarget("", { pull_request: { number: 7, head: { sha: "abc" } } }),
    ).toEqual({ pr: 7 });
  });

  it("finds nothing in an event that is not about a pull request", () => {
    expect(resolveTarget("", { ref: "refs/heads/dev" })).toBeUndefined();
    expect(resolveTarget(undefined, {})).toBeUndefined();
  });

  it("rejects a number that is not a positive integer", () => {
    for (const value of ["0", "-3", "12abc", "1.5"]) {
      expect(() => resolveTarget(value, {})).toThrow(
        "pr_number must be a positive integer",
      );
    }
  });
});

describe("buildRiskRun", () => {
  it("reports what the runner says about the run", () => {
    expect(
      buildRiskRun(false, {
        GITHUB_EVENT_NAME: "workflow_run",
        GITHUB_RUN_ID: "8842",
        GITHUB_RUN_ATTEMPT: "3",
      }),
    ).toEqual({
      runner: "droid-action",
      trigger: "workflow_run",
      runId: "8842",
      runAttempt: 3,
      dryRun: false,
    });
  });

  it("leaves out what it cannot attest to", () => {
    expect(buildRiskRun(true, { GITHUB_RUN_ATTEMPT: "soon" })).toEqual({
      runner: "droid-action",
      dryRun: true,
    });
  });
});

describe("inputs", () => {
  it("reads only an explicit true as a flag", () => {
    expect(parseFlag(" TRUE ")).toBe(true);
    for (const value of [undefined, "", "false", "1", "yes"]) {
      expect(parseFlag(value)).toBe(false);
    }
  });

  it("reports a review conclusion only when it is one GitHub produces", () => {
    expect(parseReviewOutcome(" failure ")).toBe("failure");
    expect(parseReviewOutcome("neutral")).toBeUndefined();
    expect(parseReviewOutcome("")).toBeUndefined();
  });

  it("places the plan and result under the runner's temp directory unless told otherwise", () => {
    const env = { RUNNER_TEMP: "/runner/temp" };
    expect(riskPlanPath(env)).toBe("/runner/temp/pr-risk/plan.json");
    expect(riskResultPath(env)).toBe("/runner/temp/pr-risk/result.json");
    expect(
      riskPlanPath({ ...env, RISK_PLAN_PATH: "/elsewhere/plan.json" }),
    ).toBe("/elsewhere/plan.json");
    expect(() => riskResultPath({})).toThrow("RUNNER_TEMP is not set");
  });
});

describe("failures", () => {
  it("labels only its own errors, and only with a well-formed reason", () => {
    expect(failureReason(new RiskError("judge_timeout", "timed out"))).toBe(
      "judge_timeout",
    );
    expect(failureReason(new RiskError("Not A Label", "odd"))).toBe(
      "unexpected",
    );
    expect(failureReason(new Error("boom"))).toBe("unexpected");
    expect(failureReason("boom")).toBe("unexpected");
  });

  it("removes the job's credentials from a message before it is logged", () => {
    const saved = process.env.FACTORY_API_KEY;
    process.env.FACTORY_API_KEY = "fk-super-secret-value";
    try {
      const logged = describeFailure(
        new Error(
          `request with fk-super-secret-value failed ${"x".repeat(5000)}`,
        ),
      );
      expect(logged).not.toContain("fk-super-secret-value");
      expect(logged.length).toBeLessThanOrEqual(2000);
    } finally {
      if (saved === undefined) delete process.env.FACTORY_API_KEY;
      else process.env.FACTORY_API_KEY = saved;
    }
  });
});

describe("plan and result files", () => {
  let dir = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-risk-plan-test-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the plan readable by its owner alone, even over a file that was not", async () => {
    const path = join(dir, "nested", "plan.json");
    const plan = planFor();
    await writePrivateJson(path, plan);
    expect((await stat(path)).mode % 0o1000).toBe(0o600);
    expect((await stat(join(dir, "nested"))).mode % 0o1000).toBe(0o700);
    expect(await readRiskPlan(path)).toEqual(plan);

    const loose = join(dir, "loose.json");
    await writeFile(loose, "{}", { mode: 0o644 });
    await writePrivateJson(loose, plan);
    expect((await stat(loose)).mode % 0o1000).toBe(0o600);
  });

  it("reports an unreadable plan without quoting it", async () => {
    const path = join(dir, "broken-plan.json");
    await writeFile(path, JSON.stringify({ ...planFor(), headSha: "SERVED" }));

    const failure = await readRiskPlan(path).catch((error: unknown) => error);

    expect(failure).toMatchObject({ reason: "plan_unreadable" });
    expect(String(failure)).not.toContain("SERVED");
    await expect(readRiskPlan(join(dir, "missing.json"))).rejects.toMatchObject(
      { reason: "plan_unreadable" },
    );
  });

  it("reads a missing result as a runner that died and a broken one as unreadable", async () => {
    expect(await readRiskResult(join(dir, "no-result.json"))).toEqual({
      result: { status: "failed", reason: "runner_died" },
    });

    const path = join(dir, "broken-result.json");
    await writeFile(path, '{"result":{"status":"judged"}}');
    expect(await readRiskResult(path)).toEqual({
      result: { status: "failed", reason: "result_unreadable" },
    });
  });

  it("round-trips a judged result", async () => {
    const path = join(dir, "result.json");
    const result: RiskResultFile = {
      droidCliVersion: "1.2.3",
      result: {
        status: "judged",
        baseSha: "b".repeat(40),
        judgeSha256: judge.sha256,
        snapshotHash: "f".repeat(64),
        listedFiles: 1,
        attempts: [{ sessionId: "s1", valid: true, durationMs: 12 }],
        durationMs: 34,
        verdict: validVerdict,
      },
    };
    await writePrivateJson(path, result);

    expect(await readRiskResult(path)).toEqual(result);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result);
  });
});

describe("buildSettleRequest", () => {
  const plan = planFor();

  it("reports the planned head, the run with the CLI version, and the result as left", () => {
    const result: RiskResultFile["result"] = {
      status: "judged",
      baseSha: plan.baseSha,
      judgeSha256: judge.sha256,
      snapshotHash: "f".repeat(64),
      listedFiles: 1,
      attempts: [{ sessionId: "s1", valid: true }],
      durationMs: 34,
      verdict: validVerdict,
    };

    expect(
      buildSettleRequest(plan, { droidCliVersion: "1.2.3", result }),
    ).toEqual({
      repo: "acme/app",
      pr: 123,
      headSha: plan.headSha,
      run: { ...plan.run, droidCliVersion: "1.2.3" },
      result,
    });
  });

  it("reports a failure as it was recorded, without naming the judge", () => {
    expect(
      buildSettleRequest(plan, {
        result: { status: "failed", reason: "runner_died" },
      }).result,
    ).toEqual({ status: "failed", reason: "runner_died" });
  });

  it("settles a result too large to send as a failure instead of dropping it", () => {
    const request = buildSettleRequest(plan, {
      result: {
        status: "judged",
        baseSha: plan.baseSha,
        judgeSha256: judge.sha256,
        snapshotHash: "f".repeat(64),
        listedFiles: 1,
        attempts: [{ valid: true }],
        durationMs: 34,
        verdict: { ...validVerdict, details: "x".repeat(300 * 1024) },
      },
    });

    expect(request.result).toEqual({
      status: "failed",
      reason: "result_too_large",
    });
    expect(request.headSha).toBe(plan.headSha);
  });
});
