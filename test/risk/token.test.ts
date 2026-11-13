import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import { parseAppTokenPermissions } from "../../src/github/token-permissions";
import { JUDGE_TOKEN_PERMISSIONS, mintJudgeToken } from "../../src/risk/token";

let setSecret: ReturnType<typeof spyOn>;
beforeEach(() => {
  setSecret = spyOn(core, "setSecret").mockImplementation(() => {});
});
afterEach(() => {
  setSecret.mockRestore();
});

describe("judge token", () => {
  it("asks for read access only", () => {
    expect(JUDGE_TOKEN_PERMISSIONS).toEqual({
      contents: "read",
      pull_requests: "read",
      issues: "read",
      checks: "read",
      statuses: "read",
    });
  });

  it("exchanges the job's identity for a token narrowed to those permissions and masks it", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const token = await mintJudgeToken({
      getIdToken: async () => "synthetic-oidc-token",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return Response.json({ token: "synthetic-judge-token" });
      },
    });
    expect(token).toBe("synthetic-judge-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://app.factory.ai/api/github/token-exchange",
    );
    expect(
      (calls[0]!.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer synthetic-oidc-token");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      permissions: JUDGE_TOKEN_PERMISSIONS,
    });
    expect(setSecret).toHaveBeenCalledWith("synthetic-judge-token");
  });

  it("throws on a refused exchange, naming the status and error code only", async () => {
    const failure = await mintJudgeToken({
      getIdToken: async () => "synthetic-oidc-token",
      fetchImpl: async () =>
        Response.json(
          {
            error: "permission_not_allowed",
            error_code: "checks",
            detail: "synthetic-body-detail",
          },
          { status: 403 },
        ),
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe(
      "Judge token exchange failed with status 403 (permission_not_allowed/checks)",
    );
  });

  it("throws when the exchange returns no token or the job has no identity", async () => {
    await expect(
      mintJudgeToken({
        getIdToken: async () => "synthetic-oidc-token",
        fetchImpl: async () => Response.json({}),
      }),
    ).rejects.toThrow("returned no token");
    await expect(
      mintJudgeToken({
        getIdToken: async () => {
          throw new Error("no id-token permission");
        },
        fetchImpl: async () => {
          throw new Error("must not be reached");
        },
      }),
    ).rejects.toThrow("the job needs `id-token: write`");
  });
});

describe("token permission schema", () => {
  it("accepts the judge's permission set and refuses write access to CI results", () => {
    expect(
      parseAppTokenPermissions(JSON.stringify(JUDGE_TOKEN_PERMISSIONS)),
    ).toEqual(JUDGE_TOKEN_PERMISSIONS);
    for (const name of ["checks", "statuses"])
      expect(() =>
        parseAppTokenPermissions(JSON.stringify({ [name]: "write" })),
      ).toThrow("not a supported permission set");
  });
});
