import { describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import * as token from "../../src/github/token";
import * as client from "../../src/github/api/client";
import * as contextMod from "../../src/github/context";
import * as validator from "../../src/tag/commands/review-validator";

describe("prepare-validator entrypoint", () => {
  it("fails when reviewUseValidator is false", async () => {
    const setFailedSpy = spyOn(core, "setFailed").mockImplementation(() => {});
    const setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    spyOn(contextMod, "parseGitHubContext").mockReturnValue({
      eventName: "issue_comment",
      runId: "1",
      repository: { owner: "o", repo: "r", full_name: "o/r" },
      actor: "a",
      inputs: {
        triggerPhrase: "@droid",
        assigneeTrigger: "",
        labelTrigger: "droid",
        useStickyComment: false,
        allowedBots: "",
        allowedNonWriteUsers: "",
        trackProgress: false,
        automaticReview: false,
      },
      payload: {} as any,
      entityNumber: 1,
      isPR: true,
    } as any);

    process.env.REVIEW_USE_VALIDATOR = "false";
    process.env.DROID_COMMENT_ID = "123";

    spyOn(token, "setupGitHubToken").mockResolvedValue("token");
    spyOn(client, "createOctokit").mockReturnValue({} as any);
    spyOn(validator, "prepareReviewValidatorMode").mockResolvedValue({
      commentId: 123,
      branchInfo: { baseBranch: "main", droidBranch: "feat" },
      mcpTools: "{}",
    } as any);

    const mod = await import(
      `../../src/entrypoints/prepare-validator.ts?test=${Math.random()}`,
    );

    await expect(mod.default()).rejects.toBeTruthy();

    expect(setFailedSpy).toHaveBeenCalled();
    expect(setOutputSpy).toHaveBeenCalledWith(
      "prepare_error",
      expect.stringContaining("reviewUseValidator"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    setFailedSpy.mockRestore();
    setOutputSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
