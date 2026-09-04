import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import * as promptModule from "../../../src/create-prompt";
import * as prFetcher from "../../../src/github/data/pr-fetcher";
import { prepareReviewValidatorMode } from "../../../src/tag/commands/review-validator";
import { createMockContext } from "../../mockContext";

describe("prepareReviewValidatorMode", () => {
  const savedArgs = process.env.DROID_ARGS;
  const savedFactoryKey = process.env.FACTORY_API_KEY;
  const savedRunnerTemp = process.env.RUNNER_TEMP;

  beforeEach(() => {
    process.env.RUNNER_TEMP = "/tmp/test-runner";
    delete process.env.FACTORY_API_KEY;
  });

  afterEach(() => {
    if (savedArgs === undefined) delete process.env.DROID_ARGS;
    else process.env.DROID_ARGS = savedArgs;
    if (savedFactoryKey === undefined) delete process.env.FACTORY_API_KEY;
    else process.env.FACTORY_API_KEY = savedFactoryKey;
    if (savedRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = savedRunnerTemp;
  });

  it("exposes only file-writing tools and strips custom tool flags", async () => {
    process.env.DROID_ARGS =
      '--enabled-tools "github_pr___submit_review,github_comment___update_droid_comment" --verbose';

    const fetchSpy = spyOn(prFetcher, "fetchPRBranchData").mockResolvedValue({
      baseRefName: "main",
      headRefName: "feature",
      headRefOid: "abc123",
      title: "PR",
      body: "",
    });
    const promptSpy = spyOn(promptModule, "createPrompt").mockResolvedValue();
    const setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    const exportSpy = spyOn(core, "exportVariable").mockImplementation(
      () => {},
    );

    const result = await prepareReviewValidatorMode({
      context: createMockContext({ isPR: true, entityNumber: 24 }),
      octokit: {} as any,
      githubToken: "token",
      trackingCommentId: 555,
    });

    const args = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    )?.[1] as string;
    expect(args).toContain(
      "Read,Grep,Glob,LS,Execute,ApplyPatch,Create,Edit,Skill",
    );
    expect(args).toContain("--verbose");
    expect(args).not.toContain("github_pr___submit_review");
    expect(args).not.toContain("github_comment___update_droid_comment");
    expect(setOutputSpy).toHaveBeenCalledWith("mcp_tools", '{"mcpServers":{}}');
    expect(result.mcpTools).toBe('{"mcpServers":{}}');

    fetchSpy.mockRestore();
    promptSpy.mockRestore();
    setOutputSpy.mockRestore();
    exportSpy.mockRestore();
  });
});
