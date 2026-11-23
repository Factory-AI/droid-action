import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import * as core from "@actions/core";
import * as token from "../../src/github/token";
import * as client from "../../src/github/api/client";
import * as contextMod from "../../src/github/context";
import * as validator from "../../src/tag/commands/review-validator";
import { DroidRunType } from "../../src/run-type";

const PR_CONTEXT = {
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
} as any;

async function loadEntrypoint() {
  return import(
    `../../src/entrypoints/prepare-validator.ts?test=${Math.random()}`
  );
}

// A spy on an imported module outlives the file that installed it. Leaving
// setupGitHubToken stubbed here made test/github/token.test.ts fail whenever
// the runner happened to order this file first, which is what CI did.
describe("prepare-validator entrypoint", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.DROID_EXEC_RUN_TYPE = DroidRunType.Review;
  });

  afterEach(() => {
    mock.restore();
    for (const name of [
      "GITHUB_TOKEN",
      "DROID_COMMENT_ID",
      "DROID_EXEC_RUN_TYPE",
      "REVIEW_CANDIDATES_PATH",
    ]) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  });

  it("fails when DROID_COMMENT_ID is missing", async () => {
    const setFailedSpy = spyOn(core, "setFailed").mockImplementation(() => {});
    const setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    spyOn(core, "setSecret").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    spyOn(contextMod, "parseGitHubContext").mockReturnValue(PR_CONTEXT);

    process.env.GITHUB_TOKEN = "existing-token";
    delete process.env.DROID_COMMENT_ID;
    delete process.env.REVIEW_CANDIDATES_PATH;

    spyOn(client, "createOctokit").mockReturnValue({} as any);
    spyOn(validator, "prepareReviewValidatorMode").mockResolvedValue({
      commentId: 123,
      branchInfo: { baseBranch: "main", droidBranch: "feat" },
      mcpTools: "{}",
    } as any);

    const mod = await loadEntrypoint();

    await expect(mod.default()).rejects.toBeTruthy();

    expect(setFailedSpy).toHaveBeenCalled();
    expect(setOutputSpy).toHaveBeenCalledWith(
      "prepare_error",
      expect.stringContaining("DROID_COMMENT_ID"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("reuses the run's token instead of minting and publishing another", async () => {
    const setFailedSpy = spyOn(core, "setFailed").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Unexpected process.exit(${code})`);
    });
    const outputs: Record<string, string> = {};
    spyOn(core, "setOutput").mockImplementation(((
      name: string,
      value: unknown,
    ) => {
      outputs[name] = String(value);
    }) as any);
    const setSecretSpy = spyOn(core, "setSecret").mockImplementation(() => {});
    spyOn(contextMod, "parseGitHubContext").mockReturnValue(PR_CONTEXT);
    const mintSpy = spyOn(token, "setupGitHubToken").mockImplementation(
      async () => {
        throw new Error("must not mint");
      },
    );
    const octokitSpy = spyOn(client, "createOctokit").mockReturnValue(
      {} as any,
    );
    const validatorSpy = spyOn(
      validator,
      "prepareReviewValidatorMode",
    ).mockResolvedValue({
      commentId: 5,
      branchInfo: { baseBranch: "main", droidBranch: "feat" },
      mcpTools: '{"mcpServers":{}}',
    } as any);

    process.env.GITHUB_TOKEN = "existing-token";
    process.env.DROID_COMMENT_ID = "5";
    delete process.env.REVIEW_CANDIDATES_PATH;

    const mod = await loadEntrypoint();
    await mod.default();

    expect(setFailedSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mintSpy).not.toHaveBeenCalled();
    expect(setSecretSpy).toHaveBeenCalledWith("existing-token");
    expect(octokitSpy).toHaveBeenCalledWith("existing-token");
    expect(validatorSpy.mock.calls[0]![0].githubToken).toBe("existing-token");
    expect(validatorSpy.mock.calls[0]![0].runType).toBe(DroidRunType.Review);
    expect(outputs.validator_should_run).toBe("true");
    expect(Object.keys(outputs)).not.toContain("github_token");
    expect(Object.keys(outputs)).not.toContain("GITHUB_TOKEN");
  });

  it.each([
    DroidRunType.Help,
    DroidRunType.SecurityScan,
    "ambient-invalid",
    "",
  ])(
    "rejects the explicit non-PR or invalid role %s before creating a client",
    async (runType) => {
      spyOn(core, "setFailed").mockImplementation(() => {});
      const setOutputSpy = spyOn(core, "setOutput").mockImplementation(
        () => {},
      );
      spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      spyOn(contextMod, "parseGitHubContext").mockReturnValue(PR_CONTEXT);
      const octokitSpy = spyOn(client, "createOctokit").mockReturnValue(
        {} as any,
      );
      process.env.DROID_EXEC_RUN_TYPE = runType;
      process.env.GITHUB_TOKEN = "existing-token";
      process.env.DROID_COMMENT_ID = "5";
      delete process.env.REVIEW_CANDIDATES_PATH;

      const mod = await loadEntrypoint();
      await expect(mod.default()).rejects.toThrow("process.exit");
      expect(setOutputSpy).toHaveBeenCalledWith(
        "prepare_error",
        "prepare-validator requires a trusted PR review run type",
      );
      expect(octokitSpy).not.toHaveBeenCalled();
    },
  );

  it("fails without a token rather than minting one", async () => {
    const setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    spyOn(core, "setFailed").mockImplementation(() => {});
    spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    spyOn(contextMod, "parseGitHubContext").mockReturnValue(PR_CONTEXT);
    const mintSpy = spyOn(token, "setupGitHubToken").mockResolvedValue("new");

    delete process.env.GITHUB_TOKEN;
    process.env.DROID_COMMENT_ID = "5";
    delete process.env.REVIEW_CANDIDATES_PATH;

    const mod = await loadEntrypoint();
    await expect(mod.default()).rejects.toBeTruthy();

    expect(mintSpy).not.toHaveBeenCalled();
    expect(setOutputSpy).toHaveBeenCalledWith(
      "prepare_error",
      expect.stringContaining("GITHUB_TOKEN"),
    );
  });
});
