import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import * as core from "@actions/core";
import { createHash } from "crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { run as runAssess } from "../../src/entrypoints/risk-assess";
import { run as runPlan } from "../../src/entrypoints/risk-plan";
import { run as runPublish } from "../../src/entrypoints/risk-publish";
import type { RiskAssessDependencies } from "../../src/risk/assess";
import { readRiskHandoff, writeRiskHandoff } from "../../src/risk/handoff";
import type { RiskPlan } from "../../src/risk/plan";
import type {
  RiskPublishRequest,
  RiskPublishResponse,
} from "../../src/risk/publish";
import { evidenceAt, execSummary, judgePlan, sha } from "./fixtures";

let directory: string;
let outputs: Record<string, string>;
let warnings: string[];
let notices: string[];
let spies: ReturnType<typeof spyOn>[];

beforeAll(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "risk-entry-")));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  outputs = {};
  warnings = [];
  notices = [];
  spies = [
    spyOn(core, "setOutput").mockImplementation((name, value) => {
      outputs[name] = String(value);
    }),
    spyOn(core, "warning").mockImplementation((message) => {
      warnings.push(String(message));
    }),
    spyOn(core, "notice").mockImplementation((message) => {
      notices.push(String(message));
    }),
  ];
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

const planEnv = () => ({
  GITHUB_REPOSITORY: "acme/widgets",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_RUN_ID: "321",
  RISK_EVENT_ACTION: "synchronize",
  RISK_EVENT_PR_NUMBER: "7",
  RISK_EVENT_HEAD_SHA: sha("a"),
  RISK_EVENT_HEAD_REPO: "acme/widgets",
  FACTORY_API_KEY: "synthetic-factory-key",
  RUNNER_TEMP: directory,
});

describe("risk-plan entrypoint", () => {
  async function plan(
    answer: RiskPlan,
    env: Record<string, string> = planEnv(),
  ) {
    const requests: unknown[][] = [];
    await runPlan(env, {
      requestPlan: async (...request) => {
        requests.push(request);
        return answer;
      },
    });
    return requests;
  }

  it("hands a judge plan to the next step with the digest of its exact bytes", async () => {
    const requests = await plan(judgePlan());
    expect(requests).toEqual([
      [
        {
          repo: "acme/widgets",
          pr: 7,
          trigger: "synchronize",
          eventHeadSha: sha("a"),
        },
        {
          runner: "droid-action",
          trigger: "pull_request",
          runId: "321",
          dryRun: false,
        },
        { baseUrl: "https://api.factory.ai", apiKey: "synthetic-factory-key" },
      ],
    ]);
    expect(outputs).toMatchObject({
      action: "judge",
      pr_number: "7",
      head_sha: sha("a"),
    });
    expect(dirname(dirname(outputs.plan_path!))).toBe(directory);
    expect(
      createHash("sha256")
        .update(await readFile(outputs.plan_path!))
        .digest("hex"),
    ).toBe(outputs.plan_sha256!);
    expect(
      await readRiskHandoff(outputs.plan_path, outputs.plan_sha256),
    ).toEqual(judgePlan());
  });

  it.each([
    [{ action: "skip", reason: "gate_off" }],
    [{ action: "hold", reason: "unresolved_threads", unresolvedThreads: 2 }],
  ] as [RiskPlan][])("reports %j and hands nothing on", async (answer) => {
    await plan(answer);
    expect(outputs).toEqual({
      action: answer.action,
      reason: (answer as { reason: string }).reason,
      pr_number: "7",
    });
  });

  it("warns about a plan it cannot read and hands nothing on", async () => {
    await plan({ action: "unknown", reportedAction: "defer" });
    expect(outputs).toEqual({ action: "unknown", pr_number: "7" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("defer");
  });

  it("does not ask the backend about a fork or an event it does not assess", async () => {
    const requests = await plan(judgePlan(), {
      ...planEnv(),
      RISK_EVENT_HEAD_REPO: "mallory/widgets",
    });
    expect(requests).toEqual([]);
    expect(outputs).toEqual({ action: "skip", reason: "fork" });
  });

  it("fails instead of asking without a key", async () => {
    const { FACTORY_API_KEY: _key, ...env } = planEnv();
    await expect(plan(judgePlan(), env)).rejects.toThrow(
      "A Factory API key is required",
    );
    expect(outputs.action).toBeUndefined();
  });
});

describe("risk-assess entrypoint", () => {
  const answer = { verdict: false, brief: "Risky.", details: "Rewrites auth." };

  async function assessEnv(plan: unknown = judgePlan({ scores: {} })) {
    const dir = await mkdtemp(join(directory, "assess-"));
    const handoff = await writeRiskHandoff(dir, "plan.json", plan);
    const cli = join(dir, "droid");
    await writeFile(cli, "frozen bytes");
    return {
      GITHUB_REPOSITORY: "acme/widgets",
      GITHUB_WORKSPACE: "/workspace",
      RISK_PLAN_PATH: handoff.path,
      RISK_PLAN_SHA256: handoff.sha256,
      RISK_PLAN_PR_NUMBER: "7",
      RISK_CLI_PATH: cli,
      RISK_CLI_SHA256: createHash("sha256")
        .update("frozen bytes")
        .digest("hex"),
      REVIEW_GITHUB_TOKEN: "review-token",
      FACTORY_API_KEY: "synthetic-factory-key",
    };
  }
  function dependencies(
    env: Record<string, string>,
    stdout: string,
    events: string[] = [],
  ): RiskAssessDependencies {
    return {
      revokeToken: async (token) => {
        events.push(`revoke:${token}`);
      },
      mintJudgeToken: async () => "judge-token",
      fetchPullRequest: async () => ({
        title: "Change a",
        headSha: sha("a"),
        additions: 1,
        deletions: 0,
        changedFiles: 0,
        files: [],
      }),
      createEvidence: async (_snapshot, options) => {
        events.push(`evidence:${options.parentDir}:${options.sourceRepoDir}`);
        const evidence = evidenceAt(
          await mkdtemp(join(options.parentDir, "evidence-")),
        );
        await mkdir(evidence.rootDir);
        return evidence;
      },
      removeEvidence: async () => {},
      execute: async (cliPath, invocation) => {
        events.push(`execute:${cliPath === env.RISK_CLI_PATH}`);
        return invocation.args[0] === "--version" ? "droid 9.9.9" : stdout;
      },
      hashFile: async () => env.RISK_CLI_SHA256!,
    };
  }

  it("judges the handed-off plan and hands the raw answer on with its digest", async () => {
    const env = await assessEnv();
    const events: string[] = [];
    await runAssess(
      env,
      dependencies(env, execSummary(JSON.stringify(answer)), events),
    );
    expect(events).toEqual([
      "revoke:review-token",
      `evidence:${dirname(env.RISK_PLAN_PATH)}:/workspace`,
      "execute:true",
      "execute:true",
      "revoke:judge-token",
    ]);
    expect(outputs.status).toBe("assessed");
    expect(dirname(outputs.assessment_path!)).toBe(dirname(env.RISK_PLAN_PATH));
    expect(
      await readRiskHandoff(outputs.assessment_path, outputs.assessment_sha256),
    ).toMatchObject({
      droidCliVersion: "droid 9.9.9",
      rawAssessment: { headSha: sha("a"), verdict: answer },
    });
  });

  it("reports no verdict without handing anything on", async () => {
    const env = await assessEnv();
    await runAssess(env, dependencies(env, execSummary("no object")));
    expect(outputs).toEqual({ status: "no_verdict" });
    expect(warnings).toEqual(["The risk judge produced no valid verdict."]);
  });

  it("refuses a plan that changed after the plan step wrote it", async () => {
    const env = await assessEnv();
    await writeFile(
      env.RISK_PLAN_PATH,
      JSON.stringify(judgePlan({ enabledTools: ["Execute", "Create"] })),
    );
    const events: string[] = [];
    await expect(runAssess(env, dependencies(env, "", events))).rejects.toThrow(
      "changed after it was written",
    );
    expect(events).toEqual([]);
  });

  it("refuses a handed-off plan that is not a judge plan, before touching any token", async () => {
    const env = await assessEnv({ action: "hold", reason: "x" });
    const events: string[] = [];
    await expect(runAssess(env, dependencies(env, "", events))).rejects.toThrow(
      "There is no judge plan to assess",
    );
    expect(events).toEqual([]);
  });

  it("refuses a frozen executable that changed, before touching any token", async () => {
    const env = await assessEnv();
    await writeFile(env.RISK_CLI_PATH, "other bytes");
    const events: string[] = [];
    await expect(runAssess(env, dependencies(env, "", events))).rejects.toThrow(
      "changed after it was frozen",
    );
    expect(events).toEqual([]);
  });
});

describe("risk-publish entrypoint", () => {
  const published: RiskPublishResponse = {
    status: "published",
    publication: {
      comment: { action: "updated", id: 5 },
      approval: { action: "approved" },
    },
    outcome: "approve",
  };
  const rawAssessment = { headSha: sha("a"), verdict: { verdict: true } };

  async function publishEnv(assessment: unknown = { rawAssessment }) {
    const dir = await mkdtemp(join(directory, "publish-"));
    const handoff = await writeRiskHandoff(dir, "assessment.json", assessment);
    return {
      GITHUB_REPOSITORY: "acme/widgets",
      GITHUB_RUN_ID: "321",
      RISK_PLAN_PR_NUMBER: "7",
      RISK_PLAN_HEAD_SHA: sha("a"),
      RISK_ASSESS_STATUS: "assessed",
      RISK_ASSESSMENT_PATH: handoff.path,
      RISK_ASSESSMENT_SHA256: handoff.sha256,
      FACTORY_API_KEY: "synthetic-factory-key",
    };
  }
  async function publish(
    env: Record<string, string>,
    response: RiskPublishResponse = published,
  ) {
    const requests: RiskPublishRequest[] = [];
    await runPublish(env, {
      publish: async (request) => {
        requests.push(request);
        return response;
      },
    });
    expect(requests).toHaveLength(1);
    return requests[0]!;
  }

  it("sends the raw answer for the planned head and reports what the backend decided", async () => {
    const env = await publishEnv({
      rawAssessment,
      droidCliVersion: "droid 9.9.9",
    });
    expect(await publish({ ...env, RISK_DRY_RUN: "true" })).toEqual({
      repo: "acme/widgets",
      pr: 7,
      expectedHeadSha: sha("a"),
      run: {
        runner: "droid-action",
        runId: "321",
        droidCliVersion: "droid 9.9.9",
        dryRun: true,
      },
      rawAssessment,
    } as unknown as RiskPublishRequest);
    expect(outputs).toEqual({
      status: "published",
      outcome: "approve",
      reason: "",
      comment: "updated",
      approval: "approved",
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("approve");
  });

  it.each([
    ["the judge step failed", { RISK_ASSESS_STATUS: "failed" }],
    ["the judge step never ran", { RISK_ASSESS_STATUS: "" }],
    ["the judge produced no verdict", { RISK_ASSESS_STATUS: "no_verdict" }],
    ["the assessment is for another head", { RISK_PLAN_HEAD_SHA: sha("9") }],
    ["the assessment digest is missing", { RISK_ASSESSMENT_SHA256: "" }],
  ])("publishes the head without an answer when %s", async (_label, change) => {
    const env = { ...(await publishEnv()), ...change };
    const request = await publish(env, {
      status: "published",
      publication: { comment: { action: "created", id: 5 } },
    });
    expect(request.rawAssessment).toBeUndefined();
    expect(request.expectedHeadSha).toBe(env.RISK_PLAN_HEAD_SHA);
    expect(outputs).toMatchObject({
      status: "published",
      outcome: "unavailable",
      approval: "untouched",
    });
  });

  it("publishes the head without an answer when the assessment changed after the judge step wrote it", async () => {
    const env = await publishEnv();
    await writeFile(
      env.RISK_ASSESSMENT_PATH,
      JSON.stringify({
        rawAssessment: { ...rawAssessment, verdict: { verdict: false } },
      }),
    );
    expect((await publish(env)).rawAssessment).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("changed after it was written");
  });

  it("reports a head that moved and nothing else", async () => {
    await publish(await publishEnv(), {
      status: "stale_head",
      headSha: sha("9"),
    });
    expect(outputs).toEqual({ status: "stale_head" });
    expect(notices).toEqual([]);
  });

  it("fails without a planned head", async () => {
    const { RISK_PLAN_HEAD_SHA: _head, ...env } = await publishEnv();
    await expect(
      runPublish(env, {
        publish: async () => {
          throw new Error("must not be reached");
        },
      }),
    ).rejects.toThrow("There is no planned head to publish for");
  });
});
