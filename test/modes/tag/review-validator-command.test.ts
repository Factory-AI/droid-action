import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import * as promptModule from "../../../src/create-prompt";
import * as prFetcher from "../../../src/github/data/pr-fetcher";
import { prepareReviewValidatorMode } from "../../../src/tag/commands/review-validator";
import { createMockContext } from "../../mockContext";
import { parseSessionTagFromDroidArgs } from "../../utils/session-tag-helpers";

describe("prepareReviewValidatorMode", () => {
  const savedArgs = process.env.DROID_ARGS;
  const savedFactoryKey = process.env.FACTORY_API_KEY;
  const savedRunnerTemp = process.env.RUNNER_TEMP;
  const savedSecurityReviewEnabled = process.env.SECURITY_REVIEW_ENABLED;

  beforeEach(() => {
    process.env.RUNNER_TEMP = "/tmp/test-runner";
    delete process.env.FACTORY_API_KEY;
    // The prepare step exports this through GITHUB_ENV when the dual review
    // spawns a security-reviewer; the validator's tag must agree with it.
    process.env.SECURITY_REVIEW_ENABLED = "true";
  });

  afterEach(() => {
    if (savedArgs === undefined) delete process.env.DROID_ARGS;
    else process.env.DROID_ARGS = savedArgs;
    if (savedFactoryKey === undefined) delete process.env.FACTORY_API_KEY;
    else process.env.FACTORY_API_KEY = savedFactoryKey;
    if (savedRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = savedRunnerTemp;
    if (savedSecurityReviewEnabled === undefined)
      delete process.env.SECURITY_REVIEW_ENABLED;
    else process.env.SECURITY_REVIEW_ENABLED = savedSecurityReviewEnabled;
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
    expect(parseSessionTagFromDroidArgs(args)).toEqual({
      name: "code-review",
      metadata: expect.objectContaining({
        pass: "validator",
        reviewType: "code",
        platform: "github",
        repo: "test-owner/test-repo",
        pr: "24",
        concurrentSecurityReview: "true",
        runId: "1234567890",
      }),
    });
    expect(setOutputSpy).toHaveBeenCalledWith("mcp_tools", '{"mcpServers":{}}');
    expect(result.mcpTools).toBe('{"mcpServers":{}}');

    fetchSpy.mockRestore();
    promptSpy.mockRestore();
    setOutputSpy.mockRestore();
    exportSpy.mockRestore();
  });
});
