import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  spyOn,
  mock,
} from "bun:test";
import * as core from "@actions/core";
import { setupGitHubToken } from "../../src/github/token";
import * as retryModule from "../../src/utils/retry";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

let exitSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  process.env = { ...originalEnv };

  exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit called with code ${code}`);
  }) as typeof process.exit);
});

afterEach(() => {
  exitSpy.mockRestore();
  global.fetch = originalFetch;
});

describe("setupGitHubToken", () => {
  test("uses override token when provided", async () => {
    process.env.OVERRIDE_GITHUB_TOKEN = "override-token";

    const setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    const setSecretSpy = spyOn(core, "setSecret").mockImplementation(() => {});
    const getIdTokenSpy = spyOn(core, "getIDToken").mockResolvedValue(
      "oidc-token",
    );

    const result = await setupGitHubToken();

    expect(result).toBe("override-token");
    expect(setSecretSpy).toHaveBeenCalledWith("override-token");
    expect(setOutputSpy).toHaveBeenCalledWith("GITHUB_TOKEN", "override-token");
    expect(getIdTokenSpy).not.toHaveBeenCalled();

    setOutputSpy.mockRestore();
    setSecretSpy.mockRestore();
    getIdTokenSpy.mockRestore();
  });

  test("fetches token via OIDC exchange when override is absent", async () => {
    delete process.env.OVERRIDE_GITHUB_TOKEN;

    const fetchMock = mock(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ token: "app-token" }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    const setSecretSpy = spyOn(core, "setSecret").mockImplementation(() => {});
    const getIdTokenSpy = spyOn(core, "getIDToken").mockResolvedValue(
      "oidc-token",
    );
    const retrySpy = spyOn(retryModule, "retryWithBackoff").mockImplementation(
      <T>(operation: () => Promise<T>) => operation(),
    );

    const result = await setupGitHubToken();

    expect(result).toBe("app-token");
    expect(getIdTokenSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(setSecretSpy).toHaveBeenCalledWith("app-token");
    expect(setOutputSpy).toHaveBeenCalledWith("GITHUB_TOKEN", "app-token");
    expect(retrySpy).toHaveBeenCalledTimes(2);

    setOutputSpy.mockRestore();
    setSecretSpy.mockRestore();
    getIdTokenSpy.mockRestore();
    retrySpy.mockRestore();
  });
  test("asks the exchange for the requested permissions", async () => {
    delete process.env.OVERRIDE_GITHUB_TOKEN;

    const fetchMock = mock(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ token: "app-token" }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    const setSecretSpy = spyOn(core, "setSecret").mockImplementation(() => {});
    const getIdTokenSpy = spyOn(core, "getIDToken").mockResolvedValue(
      "oidc-token",
    );
    const retrySpy = spyOn(retryModule, "retryWithBackoff").mockImplementation(
      <T>(operation: () => Promise<T>) => operation(),
    );

    await setupGitHubToken({ contents: "read", pull_requests: "write" });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer oidc-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      permissions: { contents: "read", pull_requests: "write" },
    });

    setOutputSpy.mockRestore();
    setSecretSpy.mockRestore();
    getIdTokenSpy.mockRestore();
    retrySpy.mockRestore();
  });
});
