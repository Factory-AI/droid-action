import { describe, expect, it } from "bun:test";
import {
  postRiskApi,
  RiskApiError,
  riskApiFromEnv,
  riskRunIdentity,
  type RiskApi,
} from "../../src/risk/api";
import {
  parseRiskPlan,
  requestRiskPlan,
  resolveRiskPlanTarget,
} from "../../src/risk/plan";
import { judgePlan, sha } from "./fixtures";

const pullRequestEvent = {
  GITHUB_REPOSITORY: "acme/widgets",
  GITHUB_EVENT_NAME: "pull_request",
  RISK_EVENT_ACTION: "opened",
  RISK_EVENT_PR_NUMBER: "42",
  RISK_EVENT_HEAD_SHA: sha("a"),
  RISK_EVENT_HEAD_REPO: "acme/widgets",
};

type Call = { url: string; init: RequestInit };
function apiAnswering(
  ...answers: (Response | Error)[]
): RiskApi & { calls: Call[]; slept: number[] } {
  const calls: Call[] = [];
  const slept: number[] = [];
  return {
    baseUrl: "https://api.example",
    apiKey: "synthetic-factory-key",
    calls,
    slept,
    sleep: async (milliseconds) => {
      slept.push(milliseconds);
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const answer = answers.shift();
      if (!answer) throw new Error("No answer left");
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("resolveRiskPlanTarget", () => {
  it("targets a same-repository pull request event at its head", () => {
    expect(resolveRiskPlanTarget(pullRequestEvent)).toEqual({
      target: {
        repo: "acme/widgets",
        pr: 42,
        trigger: "opened",
        eventHeadSha: sha("a"),
      },
    });
  });

  it.each(["reopened", "ready_for_review", "synchronize"])(
    "assesses the %s action",
    (action) => {
      expect(
        resolveRiskPlanTarget({
          ...pullRequestEvent,
          RISK_EVENT_ACTION: action,
        }),
      ).toMatchObject({ target: { pr: 42, trigger: action } });
    },
  );

  it.each([
    ["a fork's head", { RISK_EVENT_HEAD_REPO: "mallory/widgets" }, "fork"],
    ["no head repository", { RISK_EVENT_HEAD_REPO: "" }, "fork"],
    ["another action", { RISK_EVENT_ACTION: "edited" }, "event_not_assessed"],
    ["no number", { RISK_EVENT_PR_NUMBER: "" }, "event_not_assessed"],
    ["another event", { GITHUB_EVENT_NAME: "push" }, "event_not_assessed"],
    ["no repository", { GITHUB_REPOSITORY: "" }, "no_repository"],
  ])("does not ask the backend for %s", (_label, change, reason) => {
    expect(resolveRiskPlanTarget({ ...pullRequestEvent, ...change })).toEqual({
      skip: reason,
    });
  });

  it("leaves out an event head that is not a commit id", () => {
    expect(
      resolveRiskPlanTarget({
        ...pullRequestEvent,
        RISK_EVENT_HEAD_SHA: "main",
      }),
    ).toEqual({
      target: { repo: "acme/widgets", pr: 42, trigger: "opened" },
    });
  });

  it("targets the named pull request on a dispatch and nothing without one", () => {
    const dispatch = {
      GITHUB_REPOSITORY: "acme/widgets",
      GITHUB_EVENT_NAME: "workflow_dispatch",
    };
    expect(
      resolveRiskPlanTarget({ ...dispatch, RISK_PR_NUMBER: " 7 " }),
    ).toEqual({ target: { repo: "acme/widgets", pr: 7, trigger: "manual" } });
    for (const value of [undefined, "", "0", "-3", "1.5", "seven"])
      expect(
        resolveRiskPlanTarget({ ...dispatch, RISK_PR_NUMBER: value }),
      ).toEqual({ skip: "no_pull_request" });
  });
});

describe("parseRiskPlan", () => {
  it("reads skip, hold and judge answers", () => {
    expect(parseRiskPlan({ action: "skip", reason: "gate_off" })).toEqual({
      action: "skip",
      reason: "gate_off",
    });
    expect(
      parseRiskPlan({
        action: "hold",
        reason: "unresolved_threads",
        headSha: sha("a"),
        unresolvedThreads: 2,
      }),
    ).toMatchObject({ action: "hold", unresolvedThreads: 2 });
    expect(parseRiskPlan(judgePlan())).toEqual(judgePlan());
  });

  it.each([
    ["a tool that reads as a flag", { enabledTools: ["Read", "--auto"] }],
    ["a tool holding a comma", { enabledTools: ["Read,Execute"] }],
    ["no tools", { enabledTools: [] }],
    ["an empty skill", { skill: "" }],
    ["a skill digest that is not one", { skillSha256: "abc" }],
    ["a timeout of zero", { timeoutSeconds: 0 }],
    ["a score name that is not an identifier", { scores: { "a b": [1, 5] } }],
  ])("never judges on a judge plan with %s", (_label, judge) => {
    expect(parseRiskPlan(judgePlan(judge as never))).toEqual({
      action: "unknown",
      reportedAction: "judge",
    });
  });

  it("never judges on a judge plan whose head is not a commit id", () => {
    expect(parseRiskPlan({ ...judgePlan(), headSha: "main" })).toEqual({
      action: "unknown",
      reportedAction: "judge",
    });
  });

  it("reads an action it does not know, or no action, as unknown", () => {
    expect(parseRiskPlan({ action: "defer", until: "later" })).toEqual({
      action: "unknown",
      reportedAction: "defer",
    });
    for (const input of [null, "judge", [], { reason: "x" }])
      expect(parseRiskPlan(input)).toEqual({ action: "unknown" });
  });
});

describe("postRiskApi", () => {
  it("sends the key as a bearer token to the route on the configured host", async () => {
    const api = apiAnswering(json({ ok: true }));
    expect(await postRiskApi(api, "/route", { a: 1 }, 1000)).toEqual({
      ok: true,
    });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.url).toBe("https://api.example/route");
    expect(api.calls[0]!.init.method).toBe("POST");
    expect(api.calls[0]!.init.headers).toEqual({
      Authorization: "Bearer synthetic-factory-key",
      "Content-Type": "application/json",
    });
    expect(api.calls[0]!.init.body).toBe('{"a":1}');
  });

  it("repeats once after a 5xx or an unreachable backend", async () => {
    const afterServerError = apiAnswering(json({}, 503), json({ ok: 1 }));
    expect(await postRiskApi(afterServerError, "/route", {}, 1000)).toEqual({
      ok: 1,
    });
    expect(afterServerError.calls).toHaveLength(2);
    expect(afterServerError.slept).toEqual([2000]);

    const afterNetworkError = apiAnswering(
      new TypeError("fetch failed"),
      json({ ok: 2 }),
    );
    expect(await postRiskApi(afterNetworkError, "/route", {}, 1000)).toEqual({
      ok: 2,
    });
    expect(afterNetworkError.calls).toHaveLength(2);
  });

  it("gives up after the second failure", async () => {
    const api = apiAnswering(json({}, 502), json({}, 503));
    const failure = await postRiskApi(api, "/route", {}, 1000).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RiskApiError);
    expect((failure as RiskApiError).status).toBe(503);
    expect(api.calls).toHaveLength(2);
  });

  it("does not repeat a 4xx and keeps the response body out of the error", async () => {
    const api = apiAnswering(
      json({ error: "synthetic-body-detail", skill: "secret skill" }, 422),
    );
    const failure = await postRiskApi(api, "/route", {}, 1000).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RiskApiError);
    expect((failure as RiskApiError).status).toBe(422);
    expect((failure as RiskApiError).message).toBe("/route answered 422");
    expect(api.calls).toHaveLength(1);
    expect(api.slept).toEqual([]);
  });

  it("does not repeat an answer that is not JSON", async () => {
    const api = apiAnswering(new Response("<html>", { status: 200 }));
    await expect(postRiskApi(api, "/route", {}, 1000)).rejects.toThrow(
      "/route answered 200 without JSON",
    );
    expect(api.calls).toHaveLength(1);
  });
});

describe("riskApiFromEnv", () => {
  it("defaults to the production host and keeps only the origin of an override", () => {
    expect(riskApiFromEnv({ FACTORY_API_KEY: " key " })).toEqual({
      baseUrl: "https://api.factory.ai",
      apiKey: "key",
    });
    expect(
      riskApiFromEnv({
        FACTORY_API_KEY: "key",
        FACTORY_API_BASE_URL: "https://preview.example/some/path?x=1",
      }).baseUrl,
    ).toBe("https://preview.example");
  });

  it("refuses to run without a key, with a cleartext host, or with a host that is not a URL", () => {
    expect(() => riskApiFromEnv({})).toThrow("Factory API key is required");
    expect(() =>
      riskApiFromEnv({
        FACTORY_API_KEY: "key",
        FACTORY_API_BASE_URL: "http://preview.example",
      }),
    ).toThrow("must use https");
    expect(() =>
      riskApiFromEnv({ FACTORY_API_KEY: "key", FACTORY_API_BASE_URL: "nope" }),
    ).toThrow("not a URL");
  });
});

describe("riskRunIdentity", () => {
  it("names the run and is a dry run only when asked for exactly", () => {
    expect(
      riskRunIdentity(
        {
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "2",
          RISK_DRY_RUN: "true",
        },
        { droidCliVersion: "1.2.3" },
      ),
    ).toEqual({
      runner: "droid-action",
      trigger: "pull_request",
      runId: "123",
      runAttempt: 2,
      droidCliVersion: "1.2.3",
      dryRun: true,
    });
    for (const value of [undefined, "", "TRUE", "1", "yes"])
      expect(riskRunIdentity({ RISK_DRY_RUN: value })).toEqual({
        runner: "droid-action",
        dryRun: false,
      });
  });
});

describe("requestRiskPlan", () => {
  it("asks the plan route about the target and reads the answer", async () => {
    const api = apiAnswering(json(judgePlan()));
    const run = riskRunIdentity({ GITHUB_RUN_ID: "9" });
    const plan = await requestRiskPlan(
      {
        repo: "acme/widgets",
        pr: 42,
        trigger: "synchronize",
        eventHeadSha: sha("a"),
      },
      run,
      api,
    );
    expect(plan.action).toBe("judge");
    expect(api.calls[0]!.url).toBe(
      "https://api.example/api/internal/pr-risk/plan",
    );
    expect(JSON.parse(String(api.calls[0]!.init.body))).toEqual({
      repo: "acme/widgets",
      pr: 42,
      trigger: "synchronize",
      eventHeadSha: sha("a"),
      run: { runner: "droid-action", runId: "9", dryRun: false },
    });
  });
});
