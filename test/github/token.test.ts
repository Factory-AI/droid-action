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
    const getIdTokenSpy = spyOn(core, "getIDToken").mockResolvedValue("oidc-token");

    const result = await setupGitHubToken();

    expect(result).toBe("override-token");
    expect(setOutputSpy).toHaveBeenCalledWith(
      "GITHUB_TOKEN",
      "override-token",
    );
    expect(getIdTokenSpy).not.toHaveBeenCalled();

    setOutputSpy.mockRestore();
    getIdTokenSpy.mockRestore();
  });

  test("fetches token via OIDC exchange when override is absent", async () => {
    delete process.env.OVERRIDE_GITHUB_TOKEN;

    const fetchMock = mock(async () => ({
      ok: true,
      json: async () => ({ token: "app-token" }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    const getIdTokenSpy = spyOn(core, "getIDToken").mockResolvedValue("oidc-token");
    const retrySpy = spyOn(retryModule, "retryWithBackoff").mockImplementation(
      <T>(operation: () => Promise<T>) => operation(),
    );

    const result = await setupGitHubToken();

    expect(result).toBe("app-token");
    expect(getIdTokenSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setOutputSpy).toHaveBeenCalledWith("GITHUB_TOKEN", "app-token");
    expect(retrySpy).toHaveBeenCalledTimes(2);

    setOutputSpy.mockRestore();
    getIdTokenSpy.mockRestore();
    retrySpy.mockRestore();
  });
});
