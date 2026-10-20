import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as core from "@actions/core";
import { revokeGitHubAppToken } from "../../src/github/token";
import { run } from "../../src/entrypoints/revoke-github-token";
import * as retryModule from "../../src/utils/retry";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

let retrySpy: ReturnType<typeof spyOn>;

const respondWith = (status: number) => {
  const fetchMock = mock(async (_url: string, _init?: RequestInit) => ({
    status,
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

beforeEach(() => {
  process.env = { ...originalEnv };
  retrySpy = spyOn(retryModule, "retryWithBackoff").mockImplementation(
    <T>(operation: () => Promise<T>) => operation(),
  );
});

afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
  retrySpy.mockRestore();
});

describe("revokeGitHubAppToken", () => {
  test("deletes the installation token with the token itself", async () => {
    const fetchMock = respondWith(204);

    await revokeGitHubAppToken("ghs_minted");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toEndWith("/installation/token");
    expect(init?.method).toBe("DELETE");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer ghs_minted",
    );
  });

  test("treats an already revoked or expired token as done", async () => {
    respondWith(401);
    await expect(revokeGitHubAppToken("ghs_gone")).resolves.toBeUndefined();
  });

  test("throws on any other response", async () => {
    respondWith(500);
    await expect(revokeGitHubAppToken("ghs_minted")).rejects.toThrow("500");
  });
});

describe("revoke-github-token entrypoint", () => {
  test("revokes the minted token", async () => {
    process.env.GITHUB_TOKEN = "ghs_minted";
    delete process.env.OVERRIDE_GITHUB_TOKEN;
    const fetchMock = respondWith(204);

    await run();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does nothing without a token", async () => {
    delete process.env.GITHUB_TOKEN;
    const fetchMock = respondWith(204);

    await run();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("leaves a caller-provided token alone", async () => {
    process.env.GITHUB_TOKEN = "ghp_callers";
    process.env.OVERRIDE_GITHUB_TOKEN = "ghp_callers";
    const fetchMock = respondWith(204);

    await run();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("warns instead of failing the job when revocation fails", async () => {
    process.env.GITHUB_TOKEN = "ghs_minted";
    delete process.env.OVERRIDE_GITHUB_TOKEN;
    respondWith(500);
    const warningSpy = spyOn(core, "warning").mockImplementation(() => {});

    await expect(run()).resolves.toBeUndefined();
    expect(warningSpy).toHaveBeenCalledTimes(1);

    warningSpy.mockRestore();
  });
});
