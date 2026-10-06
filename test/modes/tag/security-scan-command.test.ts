import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import { prepareSecurityScanMode } from "../../../src/tag/commands/security-scan";
import { createMockContext } from "../../mockContext";
import * as prFetcher from "../../../src/github/data/pr-fetcher";
import * as promptModule from "../../../src/create-prompt";
import * as mcpInstaller from "../../../src/mcp/install-mcp-server";
import { parseSessionTagFromDroidArgs } from "../../utils/session-tag-helpers";

describe("prepareSecurityScanMode", () => {
  const originalArgs = process.env.DROID_ARGS;
  const spies: Array<ReturnType<typeof spyOn>> = [];
  let setOutputSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env.DROID_ARGS = "";
    spies.push(
      spyOn(prFetcher, "fetchRepoDefaultBranch").mockResolvedValue("main"),
      spyOn(promptModule, "createPrompt").mockResolvedValue(),
      spyOn(mcpInstaller, "prepareMcpTools").mockResolvedValue("mock-config"),
    );
    setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    spies.push(setOutputSpy);
  });

  afterEach(() => {
    spies.splice(0).forEach((spy) => spy.mockRestore());
    process.env.DROID_ARGS = originalArgs;
  });

  it("tags the session with the security_review product", async () => {
    await prepareSecurityScanMode({
      context: createMockContext(),
      octokit: { rest: {}, graphql: () => {} } as any,
      githubToken: "token",
      scanScope: { type: "full" },
    });

    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    expect(parseSessionTagFromDroidArgs(droidArgsCall?.[1] ?? "")).toEqual({
      name: "security-scan",
      metadata: { product: "security_review" },
    });
  });
});
