import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as core from "@actions/core";
import {
  beginRisk,
  getRiskOidcToken,
  settleRisk,
  type RiskClientOptions,
} from "../../../src/core/risk/client";
import type {
  RiskBeginRequest,
  RiskBeginResponse,
  RiskFetch,
  RiskSettleRequest,
} from "../../../src/core/risk/types";
import { judge, planFor } from "./fixtures";

type Call = { url: string; headers: Headers; body: unknown };

function stubFetch(answers: Array<Response | Error>): {
  calls: Call[];
  fetch: RiskFetch;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)),
      });
      const answer = answers[calls.length - 1];
      if (!answer) throw new Error("unexpected request");
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientOptions(
  fetch: RiskFetch,
  overrides: Partial<RiskClientOptions> = {},
): RiskClientOptions {
  return {
    baseUrl: "https://factory.example/",
    apiKey: "factory-key",
    fetch,
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
  it("posts the request with the API key and the workflow's OIDC token", async () => {
    const { calls, fetch } = stubFetch([json(200, judgeAnswer)]);

    const answer = await beginRisk(
      beginRequest,
      clientOptions(fetch, { getOidcToken: async () => "oidc-jwt" }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://factory.example/api/internal/pr-risk/begin",
    );
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer factory-key");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.headers.get("x-github-oidc-token")).toBe("oidc-jwt");
    expect(calls[0]?.body).toEqual(beginRequest);
    expect(answer).toEqual(judgeAnswer);
  });

  it("sends no OIDC header when the run has no token to offer", async () => {
    const { calls, fetch } = stubFetch([
      json(200, { action: "skip", reason: "nothing_to_assess" }),
    ]);

    await beginRisk(
      beginRequest,
      clientOptions(fetch, { getOidcToken: async () => undefined }),
    );

    expect(calls[0]?.headers.has("x-github-oidc-token")).toBe(false);
  });

  it("turns Factory's refusal of an untrusted workflow into a skip", async () => {
    const { fetch } = stubFetch([
      json(403, {
        detail: "This workflow may not ask.",
        code: "workflow_not_trusted",
      }),
    ]);

    expect(await beginRisk(beginRequest, clientOptions(fetch))).toEqual({
      action: "skip",
      reason: "workflow_not_trusted",
    });
  });

  it("fails on any other refusal", async () => {
    const { calls, fetch } = stubFetch([
      json(403, { detail: "Forbidden.", code: "org_disabled" }),
    ]);

    await expect(
      beginRisk(beginRequest, clientOptions(fetch)),
    ).rejects.toMatchObject({
      reason: "http_403",
      message: "PR risk begin failed with status 403: Forbidden.",
    });
    expect(calls).toHaveLength(1);
  });

  it("accepts reasons and fields it has never heard of", async () => {
    const { fetch } = stubFetch([
      json(200, {
        action: "hold",
        reason: "a_reason_added_later",
        headSha: plan.headSha,
        addedLater: { anything: true },
      }),
    ]);

    expect(await beginRisk(beginRequest, clientOptions(fetch))).toEqual({
      action: "hold",
      reason: "a_reason_added_later",
      headSha: plan.headSha,
    });
  });

  it("reads an action added after this version as a skip", async () => {
    const { fetch } = stubFetch([
      json(200, { action: "an_action_added_later", headSha: plan.headSha }),
    ]);

    expect(await beginRisk(beginRequest, clientOptions(fetch))).toEqual({
      action: "skip",
      reason: "unknown_action",
    });
  });
  it("names what it could not understand by path and code, never by value", async () => {
    const { fetch } = stubFetch([
      json(200, { ...judgeAnswer, headSha: "SERVED-VALUE" }),
    ]);

    const failure = await beginRisk(beginRequest, clientOptions(fetch)).catch(
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
    const { fetch } = stubFetch([
      json(500, {
        detail: "The judge is unavailable.",
        skill: "SERVED-SKILL-TEXT",
        debug: { token: "sk-live-123" },
      }),
    ]);

    const failure = await beginRisk(beginRequest, clientOptions(fetch)).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      reason: "http_500",
      message:
        "PR risk begin failed with status 500: The judge is unavailable.",
    });
  });

  it("quotes nothing of a failure body that is not a problem document", async () => {
    const { fetch } = stubFetch([
      new Response("upstream exploded: token=sk-live-123", { status: 500 }),
    ]);

    await expect(
      beginRisk(beginRequest, clientOptions(fetch)),
    ).rejects.toMatchObject({
      message: "PR risk begin failed with status 500",
    });
  });

  it("retries a gateway failure with a fresh OIDC token and does not retry a rejection", async () => {
    const gateway = stubFetch([
      new Response("bad gateway", { status: 503 }),
      json(200, { action: "skip", reason: "nothing_to_assess" }),
    ]);
    let minted = 0;

    await beginRisk(
      beginRequest,
      clientOptions(gateway.fetch, {
        getOidcToken: async () => `oidc-${++minted}`,
      }),
    );

    expect(
      gateway.calls.map((call) => call.headers.get("x-github-oidc-token")),
    ).toEqual(["oidc-1", "oidc-2"]);

    const rejection = stubFetch([json(400, { detail: "Bad request." })]);
    await expect(
      beginRisk(beginRequest, clientOptions(rejection.fetch)),
    ).rejects.toMatchObject({ reason: "http_400" });
    expect(rejection.calls).toHaveLength(1);
  });
});

describe("settleRisk", () => {
  it("posts the result and reads back what Factory published", async () => {
    const { calls, fetch } = stubFetch([
      json(200, {
        status: "published",
        outcome: "unavailable",
        reason: "judge_timeout",
        publication: { comment: { action: "updated", id: 42 } },
      }),
    ]);

    const answer = await settleRisk(settleRequest, clientOptions(fetch));

    expect(calls[0]?.url).toBe(
      "https://factory.example/api/internal/pr-risk/settle",
    );
    expect(calls[0]?.body).toEqual(settleRequest);
    expect(answer).toEqual({
      status: "published",
      outcome: "unavailable",
      reason: "judge_timeout",
      publication: { comment: { action: "updated" } },
    });
  });

  it("reads a head that moved on as stale rather than as a failure", async () => {
    const { fetch } = stubFetch([
      json(200, { status: "stale_head", headSha: "e".repeat(40) }),
    ]);

    expect(await settleRisk(settleRequest, clientOptions(fetch))).toEqual({
      status: "stale_head",
      headSha: "e".repeat(40),
    });
  });

  it("reads a report Factory took without publishing as skipped, whatever the reason", async () => {
    const { fetch } = stubFetch([
      json(200, {
        status: "skipped",
        reason: "a_reason_added_later",
        addedLater: { anything: true },
      }),
    ]);

    expect(await settleRisk(settleRequest, clientOptions(fetch))).toEqual({
      status: "skipped",
      reason: "a_reason_added_later",
    });
  });

  it("reads a status added after this version as unknown rather than as a failure", async () => {
    const { fetch } = stubFetch([
      json(200, { status: "a_status_added_later", outcome: "approve" }),
    ]);

    expect(await settleRisk(settleRequest, clientOptions(fetch))).toEqual({
      status: "unknown",
    });
  });
  it("gives up after three attempts when no answer arrives, without quoting the transport error", async () => {
    const down = new TypeError("fetch failed for https://factory.example");
    const { calls, fetch } = stubFetch([down, down, down]);

    await expect(
      settleRisk(settleRequest, clientOptions(fetch)),
    ).rejects.toMatchObject({
      reason: "request_failed",
      message: "PR risk settle request did not complete (TypeError)",
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
