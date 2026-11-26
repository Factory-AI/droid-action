import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as core from "@actions/core";
import {
  assertFactoryApiBaseUrl,
  beginRisk,
  getRiskOidcToken,
  settleRisk,
  type RiskClientOptions,
} from "../../../src/core/risk/client";
import type {
  RiskCall,
  RiskCallOutput,
  RiskStep,
} from "../../../src/core/risk/droid-risk";
import type {
  RiskBeginRequest,
  RiskBeginResponse,
  RiskSettleRequest,
} from "../../../src/core/risk/types";
import { judge, planFor } from "./fixtures";

type Call = { step: RiskStep; request: unknown; oidcToken?: string };

/** Stands in for `droid risk`, answering each call in turn. */
function stubCall(answers: RiskCallOutput[]): {
  calls: Call[];
  call: RiskCall;
} {
  const calls: Call[] = [];
  return {
    calls,
    call: async (step, input) => {
      calls.push({ step, ...input });
      const answer = answers[calls.length - 1];
      if (!answer) throw new Error("unexpected request");
      return answer;
    },
  };
}

function json(status: number, body: unknown): RiskCallOutput {
  return { status, body };
}

function clientOptions(
  call: RiskCall,
  overrides: Partial<RiskClientOptions> = {},
): RiskClientOptions {
  return {
    call,
    retry: { initialDelayMs: 1 },
    ...overrides,
  };
}

const beginRequest: RiskBeginRequest = {
  repo: "acme/app",
  pr: 123,
  eventHeadSha: "a".repeat(40),
  manual: false,
  reviewOutcome: "success",
  run: { runner: "droid-action", trigger: "pull_request", dryRun: false },
};

const plan = planFor();
const judgeAnswer: RiskBeginResponse = {
  action: "judge",
  headSha: plan.headSha,
  baseSha: plan.baseSha,
  pullRequest: plan.pullRequest,
  priorDeclines: [{ headSha: "d".repeat(40), concerns: "- Stale bytes." }],
  judge,
};

const settleRequest: RiskSettleRequest = {
  repo: "acme/app",
  pr: 123,
  headSha: plan.headSha,
  run: plan.run,
  result: { status: "failed", reason: "judge_timeout" },
};

afterEach(() => {
  mock.restore();
});

describe("beginRisk", () => {
  it("sends the request with the workflow's OIDC token through droid risk begin", async () => {
    const { calls, call } = stubCall([json(200, judgeAnswer)]);

    const answer = await beginRisk(
      beginRequest,
      clientOptions(call, { getOidcToken: async () => "oidc-jwt" }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      step: "begin",
      request: beginRequest,
      oidcToken: "oidc-jwt",
    });
    expect(answer).toEqual(judgeAnswer);
  });

  it("sends no OIDC token when the run has none to offer", async () => {
    const { calls, call } = stubCall([
      json(200, { action: "skip", reason: "nothing_to_assess" }),
    ]);

    await beginRisk(
      beginRequest,
      clientOptions(call, { getOidcToken: async () => undefined }),
    );

    expect(calls[0]).not.toHaveProperty("oidcToken");
  });

  it("turns Factory's refusal of an untrusted workflow into a skip", async () => {
    const { call } = stubCall([
      json(403, {
        detail: "This workflow may not ask.",
        code: "workflow_not_trusted",
      }),
    ]);

    expect(await beginRisk(beginRequest, clientOptions(call))).toEqual({
      action: "skip",
      reason: "workflow_not_trusted",
    });
  });

  it("fails on any other refusal", async () => {
    const { calls, call } = stubCall([
      json(403, { detail: "Forbidden.", code: "org_disabled" }),
    ]);

    await expect(
      beginRisk(beginRequest, clientOptions(call)),
    ).rejects.toMatchObject({
      reason: "http_403",
      message: "PR risk begin failed with status 403: Forbidden.",
    });
    expect(calls).toHaveLength(1);
  });

  it("accepts reasons and fields it has never heard of", async () => {
    const { call } = stubCall([
      json(200, {
        action: "hold",
        reason: "a_reason_added_later",
        headSha: plan.headSha,
        addedLater: { anything: true },
      }),
    ]);

    expect(await beginRisk(beginRequest, clientOptions(call))).toEqual({
      action: "hold",
      reason: "a_reason_added_later",
      headSha: plan.headSha,
    });
  });

  it("keeps the lease token of a judge answer", async () => {
    const leased = {
      ...judgeAnswer,
      leaseToken: "test-lease-placeholder",
    };
    const { call } = stubCall([json(200, leased)]);

    expect(await beginRisk(beginRequest, clientOptions(call))).toEqual(leased);
  });

  it("reads a skip reason it has never heard of as a plain skip", async () => {
    const { call } = stubCall([
      json(200, { action: "skip", reason: "in_progress" }),
    ]);

    expect(await beginRisk(beginRequest, clientOptions(call))).toEqual({
      action: "skip",
      reason: "in_progress",
    });
  });

  it("reads an action added after this version as a skip", async () => {
    const { call } = stubCall([
      json(200, { action: "an_action_added_later", headSha: plan.headSha }),
    ]);

    expect(await beginRisk(beginRequest, clientOptions(call))).toEqual({
      action: "skip",
      reason: "unknown_action",
    });
  });
  it("names what it could not understand by path and code, never by value", async () => {
    const { call } = stubCall([
      json(200, { ...judgeAnswer, headSha: "SERVED-VALUE" }),
    ]);

    const failure = await beginRisk(beginRequest, clientOptions(call)).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      reason: "invalid_response",
      message:
        "PR risk begin answer was not understood (headSha: invalid_string)",
    });
    expect(String(failure)).not.toContain("SERVED-VALUE");
  });

  it("quotes only the problem detail of a failed request", async () => {
    const { call } = stubCall([
      json(500, {
        detail: "The judge is unavailable.",
        skill: "SERVED-SKILL-TEXT",
        debug: { token: "sk-live-123" },
      }),
    ]);

    const failure = await beginRisk(beginRequest, clientOptions(call)).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      reason: "http_500",
      message:
        "PR risk begin failed with status 500: The judge is unavailable.",
    });
  });

  it("quotes nothing of a failure body that is not a problem document", async () => {
    const { call } = stubCall([
      json(500, "upstream exploded: token=sk-live-123"),
    ]);

    await expect(
      beginRisk(beginRequest, clientOptions(call)),
    ).rejects.toMatchObject({
      message: "PR risk begin failed with status 500",
    });
  });

  it("retries a gateway failure with a fresh OIDC token and does not retry a rejection", async () => {
    const gateway = stubCall([
      json(503, null),
      json(200, { action: "skip", reason: "nothing_to_assess" }),
    ]);
    let minted = 0;

    await beginRisk(
      beginRequest,
      clientOptions(gateway.call, {
        getOidcToken: async () => `oidc-${++minted}`,
      }),
    );

    expect(gateway.calls.map((sent) => sent.oidcToken)).toEqual([
      "oidc-1",
      "oidc-2",
    ]);

    const rejection = stubCall([json(400, { detail: "Bad request." })]);
    await expect(
      beginRisk(beginRequest, clientOptions(rejection.call)),
    ).rejects.toMatchObject({ reason: "http_400" });
    expect(rejection.calls).toHaveLength(1);
  });
});

describe("settleRisk", () => {
  it("posts the result and reads back what Factory published", async () => {
    const { calls, call } = stubCall([
      json(200, {
        status: "published",
        outcome: "unavailable",
        reason: "judge_timeout",
        publication: { comment: { action: "updated", id: 42 } },
      }),
    ]);

    const answer = await settleRisk(settleRequest, clientOptions(call));

    expect(calls[0]).toEqual({ step: "settle", request: settleRequest });
    expect(answer).toEqual({
      status: "published",
      outcome: "unavailable",
      reason: "judge_timeout",
      publication: { comment: { action: "updated" } },
    });
  });

  it("reads a head that moved on as stale rather than as a failure", async () => {
    const { call } = stubCall([
      json(200, { status: "stale_head", headSha: "e".repeat(40) }),
    ]);

    expect(await settleRisk(settleRequest, clientOptions(call))).toEqual({
      status: "stale_head",
      headSha: "e".repeat(40),
    });
  });

  it("reads a report Factory took without publishing as skipped, whatever the reason", async () => {
    const { call } = stubCall([
      json(200, {
        status: "skipped",
        reason: "a_reason_added_later",
        addedLater: { anything: true },
      }),
    ]);

    expect(await settleRisk(settleRequest, clientOptions(call))).toEqual({
      status: "skipped",
      reason: "a_reason_added_later",
    });
  });

  it("reads a status added after this version as unknown rather than as a failure", async () => {
    const { call } = stubCall([
      json(200, { status: "a_status_added_later", outcome: "approve" }),
    ]);

    expect(await settleRisk(settleRequest, clientOptions(call))).toEqual({
      status: "unknown",
    });
  });
  it("gives up after three attempts when no answer arrives, without quoting the transport error", async () => {
    const down: RiskCallOutput = {
      error: "request_failed",
      message: "fetch failed for https://app.factory.ai",
    };
    const { calls, call } = stubCall([down, down, down]);

    await expect(
      settleRisk(settleRequest, clientOptions(call)),
    ).rejects.toMatchObject({
      reason: "request_failed",
      message: "PR risk settle request did not complete",
    });
    expect(calls).toHaveLength(3);
  });
});

describe("getRiskOidcToken", () => {
  it("lets a dry run go without a token when the job cannot mint one", async () => {
    expect(await getRiskOidcToken(true, {})).toBeUndefined();
  });

  it("fails a real run that cannot mint a token, naming the permission", async () => {
    await expect(getRiskOidcToken(false, {})).rejects.toMatchObject({
      reason: "oidc_unavailable",
      message: expect.stringContaining("id-token: write"),
    });
  });

  it("asks for a token addressed to the risk endpoints", async () => {
    const getIDToken = spyOn(core, "getIDToken").mockResolvedValue("oidc-jwt");

    expect(
      await getRiskOidcToken(true, {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example",
      }),
    ).toBe("oidc-jwt");
    expect(getIDToken).toHaveBeenCalledWith("factory-pr-risk");
  });
});

describe("assertFactoryApiBaseUrl", () => {
  it.each([
    "https://factory.ai",
    "https://app.factory.ai",
    "https://api.factory.ai/",
    "https://staging.api.factory.ai",
  ])("accepts %s", (url) => {
    expect(assertFactoryApiBaseUrl(url)).toBe(url);
  });

  it.each([
    "https://factory.ai.evil.com",
    "https://evilfactory.ai",
    "https://app.factory.ai.",
    "http://app.factory.ai",
    "https://127.0.0.1",
    "http://127.0.0.1:3000",
    "https://[::1]",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => assertFactoryApiBaseUrl(url)).toThrow(
      expect.objectContaining({ reason: "untrusted_api_url" }),
    );
  });
});

describe("droid risk errors", () => {
  it("fails, without retrying, when the CLI refuses the API host", async () => {
    const { calls, call } = stubCall([
      {
        error: "untrusted_api_url",
        message: "Refusing to send the Factory API key to https://evil.example",
      },
    ]);

    await expect(
      beginRisk(beginRequest, clientOptions(call)),
    ).rejects.toMatchObject({
      reason: "untrusted_api_url",
      message: "Refusing to send the Factory API key to https://evil.example",
    });
    expect(calls).toHaveLength(1);
  });

  it("fails, without retrying, on any other CLI error", async () => {
    const { calls, call } = stubCall([
      { error: "invalid_input", message: "stdin must be one JSON object" },
    ]);

    await expect(
      settleRisk(settleRequest, clientOptions(call)),
    ).rejects.toMatchObject({ reason: "droid_risk_failed" });
    expect(calls).toHaveLength(1);
  });

  it("reads a success that is not JSON as an answer it does not understand", async () => {
    const { call } = stubCall([json(200, null), json(200, null)]);

    await expect(
      beginRisk(beginRequest, clientOptions(call)),
    ).rejects.toMatchObject({ reason: "invalid_response" });
    await expect(
      settleRisk(settleRequest, clientOptions(call)),
    ).rejects.toMatchObject({ reason: "invalid_response" });
  });
});
