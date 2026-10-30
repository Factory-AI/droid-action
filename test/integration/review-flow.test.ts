import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { prepareTagExecution } from "../../src/tag";
import { shouldTriggerTag } from "../../src/tag";
import { prepare } from "../../src/prepare";
import { createMockContext } from "../mockContext";
import * as createInitial from "../../src/github/operations/comments/create-initial";
import * as mcpInstaller from "../../src/mcp/install-mcp-server";
import * as actorValidation from "../../src/github/validation/actor";
import * as promptModule from "../../src/create-prompt";
import * as reviewArtifactsModule from "../../src/github/data/review-artifacts";
import * as core from "@actions/core";
import * as github from "@actions/github";
import * as childProcess from "node:child_process";
import { parseGitHubContext } from "../../src/github/context";
import { DroidRunType } from "../../src/run-type";
import { parseSessionTagFromDroidArgs } from "../utils/session-tag-helpers";

describe("review command integration", () => {
  const originalRunnerTemp = process.env.RUNNER_TEMP;
  const originalDroidArgs = process.env.DROID_ARGS;
  const originalSecurityReviewEnabled = process.env.SECURITY_REVIEW_ENABLED;
  const originalFactoryApiKey = process.env.FACTORY_API_KEY;
  const originalAutomaticInputs = {
    AUTOMATIC_REVIEW: process.env.AUTOMATIC_REVIEW,
    AUTOMATIC_SECURITY_REVIEW: process.env.AUTOMATIC_SECURITY_REVIEW,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
  };
  const originalGitHubContext = {
    eventName: github.context.eventName,
    payload: github.context.payload,
    actor: github.context.actor,
  };
  let tmpDir: string;
  let graphqlSpy: ReturnType<typeof spyOn>;
  let createCommentSpy: ReturnType<typeof spyOn>;
  let mcpSpy: ReturnType<typeof spyOn>;
  let actorSpy: ReturnType<typeof spyOn>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let exportVarSpy: ReturnType<typeof spyOn>;
  let promptSpy: ReturnType<typeof spyOn>;
  let computeArtifactsSpy: ReturnType<typeof spyOn>;
  let execSyncSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;

  function createAutomaticReviewContext(
    automaticReview: boolean,
    automaticSecurityReview: string | undefined,
  ) {
    process.env.AUTOMATIC_REVIEW = String(automaticReview);
    if (automaticSecurityReview === undefined) {
      delete process.env.AUTOMATIC_SECURITY_REVIEW;
    } else {
      process.env.AUTOMATIC_SECURITY_REVIEW = automaticSecurityReview;
    }
    github.context.eventName = "pull_request";
    github.context.actor = "human-reviewer";
    github.context.payload = {
      repository: {
        name: "test-repo",
        owner: { login: "test-owner" },
      },
      pull_request: { number: 7, body: "" },
    };
    return parseGitHubContext();
  }

  function createAutomaticReviewOctokit(
    hasExistingSecurityReview: boolean,
    botId = 138933559,
  ) {
    const octokit = {
      rest: {
        issues: {
          listComments: () =>
            Promise.resolve({
              data: hasExistingSecurityReview
                ? [
                    {
                      user: { id: botId, login: "factory-droid[bot]" },
                      body: "## Security Review Summary",
                    },
                  ]
                : [],
            }),
        },
      },
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: {
              baseRefName: "main",
              headRefName: "feature/review",
              headRefOid: "def456",
            },
          },
        }),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: "main",
          headRefName: "feature/review",
          headRefOid: "def456",
        },
      },
    });
    return octokit;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "review-int-"));
    process.env.RUNNER_TEMP = tmpDir;
    process.env.DROID_ARGS = "";
    process.env.GITHUB_REPOSITORY = "test-owner/test-repo";
    process.env.FACTORY_API_KEY = "test-factory-api-key";
    delete process.env.SECURITY_REVIEW_ENABLED;

    // Keep the real policy parsing without sending this integration test to
    // the network or depending on the runner's Factory credentials.
    const policyFetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        expect(String(input)).toEndWith("/api/organization/managed-settings");
        return Response.json({ success: true, settings: {} });
      },
      { preconnect: fetch.preconnect },
    );
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(policyFetch);

    createCommentSpy = spyOn(
      createInitial,
      "createInitialComment",
    ).mockResolvedValue({ id: 202 } as any);

    mcpSpy = spyOn(mcpInstaller, "prepareMcpTools").mockResolvedValue("{}");
    actorSpy = spyOn(actorValidation, "checkHumanActor").mockResolvedValue();
    promptSpy = spyOn(promptModule, "createPrompt").mockResolvedValue();
    computeArtifactsSpy = spyOn(
      reviewArtifactsModule,
      "computeReviewArtifacts",
    ).mockResolvedValue({
      diffPath: `${tmpDir}/droid-prompts/pr.diff`,
      commentsPath: `${tmpDir}/droid-prompts/existing_comments.json`,
      descriptionPath: `${tmpDir}/droid-prompts/pr_description.txt`,
    });
    setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    exportVarSpy = spyOn(core, "exportVariable").mockImplementation(
      (name, value) => {
        if (name === "SECURITY_REVIEW_ENABLED")
          process.env[name] = String(value);
      },
    );

    execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
      cmd: string,
    ) => {
      if (cmd.includes("merge-base")) return "abc123def456\n";
      if (cmd.includes("git --no-pager diff")) {
        return "diff --git a/file.ts b/file.ts\n+added line\n";
      }
      return "";
    }) as typeof childProcess.execSync);
  });

  afterEach(async () => {
    graphqlSpy?.mockRestore();
    createCommentSpy.mockRestore();
    mcpSpy.mockRestore();
    actorSpy.mockRestore();
    promptSpy.mockRestore();
    computeArtifactsSpy.mockRestore();
    setOutputSpy.mockRestore();
    exportVarSpy.mockRestore();
    execSyncSpy.mockRestore();
    fetchSpy.mockRestore();

    if (process.env.RUNNER_TEMP) {
      await rm(process.env.RUNNER_TEMP, { recursive: true, force: true });
    }

    if (originalRunnerTemp) {
      process.env.RUNNER_TEMP = originalRunnerTemp;
    } else {
      delete process.env.RUNNER_TEMP;
    }

    if (originalDroidArgs !== undefined) {
      process.env.DROID_ARGS = originalDroidArgs;
    } else {
      delete process.env.DROID_ARGS;
    }

    if (originalSecurityReviewEnabled !== undefined) {
      process.env.SECURITY_REVIEW_ENABLED = originalSecurityReviewEnabled;
    } else {
      delete process.env.SECURITY_REVIEW_ENABLED;
    }

    if (originalFactoryApiKey === undefined) {
      delete process.env.FACTORY_API_KEY;
    } else {
      process.env.FACTORY_API_KEY = originalFactoryApiKey;
    }

    Object.assign(github.context, originalGitHubContext);
    for (const [name, value] of Object.entries(originalAutomaticInputs)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  function candidatesSessionTag(): unknown {
    const droidArgs = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    )?.[1] as string | undefined;
    return parseSessionTagFromDroidArgs(droidArgs ?? "");
  }

  it("prepares review flow end-to-end", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      actor: "human-reviewer",
      entityNumber: 7,
      repository: {
        owner: "test-owner",
        repo: "test-repo",
        full_name: "test-owner/test-repo",
      },
      payload: {
        comment: {
          id: 888,
          body: "@droid review",
          user: { login: "human-reviewer" },
          created_at: "2024-02-02T00:00:00Z",
        },
        issue: {
          number: 7,
          pull_request: {},
        },
      } as any,
    });

    const octokit = {
      rest: {
        issues: {
          listComments: () => Promise.resolve({ data: [] }),
        },
        pulls: {
          listReviewComments: () => Promise.resolve({ data: [] }),
        },
      },
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: {
              baseRefName: "main",
              headRefName: "feature/review",
              headRefOid: "def456",
            },
          },
        }),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: "main",
          headRefName: "feature/review",
          headRefOid: "def456",
        },
      },
    });

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    expect(result.skipped).toBeFalsy();
    expect(result.branchInfo.baseBranch).toBe("main");
    expect(result.branchInfo.currentBranch).toBe("feature/review");
    expect(promptSpy).toHaveBeenCalled();
    expect(exportVarSpy).toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      DroidRunType.Review,
    );
    expect(createCommentSpy).toHaveBeenCalledWith(
      octokit.rest,
      context,
      "default",
      DroidRunType.Review,
    );

    // Verify output flags were set correctly for code review only
    const runCodeReviewCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "run_code_review",
    ) as [string, string] | undefined;
    const runSecurityReviewCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "run_security_review",
    ) as [string, string] | undefined;

    expect(runCodeReviewCall?.[1]).toBe("true");
    expect(runSecurityReviewCall?.[1]).toBe("false");
  });

  it("uses the default run type for a bare @droid command", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 888,
          body: "@droid",
          user: { login: "human-reviewer" },
          created_at: "2024-02-02T00:00:00Z",
        },
        issue: {
          number: 7,
          pull_request: {},
        },
      } as any,
    });
    const octokit = createAutomaticReviewOctokit(false);

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    expect(result.skipped).toBeFalsy();
    expect(exportVarSpy).toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      DroidRunType.Default,
    );
    expect(createCommentSpy).toHaveBeenCalledWith(
      octokit.rest,
      context,
      "default",
      DroidRunType.Default,
    );
    expect(mcpSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runType: DroidRunType.Default }),
    );
  });

  it("keeps the run type null when no command is parsed", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      inputs: {
        triggerPhrase: "/droid",
      },
      payload: {
        comment: {
          id: 888,
          body: "/droid",
          user: { login: "human-reviewer" },
          created_at: "2024-02-02T00:00:00Z",
        },
        issue: {
          number: 7,
          pull_request: {},
        },
      } as any,
    });
    const octokit = createAutomaticReviewOctokit(false);

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    expect(result.skipped).toBeFalsy();
    expect(exportVarSpy).not.toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      expect.anything(),
    );
    expect(createCommentSpy).toHaveBeenCalledWith(
      octokit.rest,
      context,
      "default",
      null,
    );
    expect(mcpSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runType: null }),
    );
  });

  it("sets security flag only for @droid security", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      actor: "human-reviewer",
      entityNumber: 7,
      repository: {
        owner: "test-owner",
        repo: "test-repo",
        full_name: "test-owner/test-repo",
      },
      payload: {
        comment: {
          id: 888,
          body: "@droid security",
          user: { login: "human-reviewer" },
          created_at: "2024-02-02T00:00:00Z",
        },
        issue: {
          number: 7,
          pull_request: {},
        },
      } as any,
    });

    const octokit = {
      rest: {},
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: {
              baseRefName: "main",
              headRefName: "feature/security",
              headRefOid: "abc123",
            },
          },
        }),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: "main",
          headRefName: "feature/security",
          headRefOid: "abc123",
        },
      },
    });

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    expect(result.skipped).toBeFalsy();
    expect(result.branchInfo.baseBranch).toBe("main");
    expect(result.branchInfo.currentBranch).toBe("feature/security");
    expect(promptSpy).toHaveBeenCalled();
    expect(exportVarSpy).toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      DroidRunType.SecurityReview,
    );
    expect(createCommentSpy).toHaveBeenCalledWith(
      octokit.rest,
      context,
      "security",
      DroidRunType.SecurityReview,
    );

    const runCodeReviewCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "run_code_review",
    ) as [string, string] | undefined;
    const runSecurityReviewCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "run_security_review",
    ) as [string, string] | undefined;

    // Standalone security now uses two-pass pipeline (candidates + validator)
    expect(runCodeReviewCall?.[1]).toBe("true");
    expect(runSecurityReviewCall?.[1]).toBe("true");
  });

  for (const { name, input } of [
    { name: "explicitly false", input: "false" },
  ]) {
    it(`keeps automatic security off when its input is ${name}`, async () => {
      const context = createAutomaticReviewContext(true, input);
      const octokit = createAutomaticReviewOctokit(false);

      const result = await prepareTagExecution({
        context,
        octokit,
        githubToken: "token",
      });

      expect(result.skipped).toBeFalsy();
      expect(createCommentSpy).toHaveBeenCalledWith(
        octokit.rest,
        context,
        "default",
        DroidRunType.Review,
      );
      expect(setOutputSpy).toHaveBeenCalledWith("run_code_review", "true");
      expect(setOutputSpy).toHaveBeenCalledWith("run_security_review", "false");
      expect(setOutputSpy).not.toHaveBeenCalledWith(
        "install_security_skills",
        "true",
      );
      expect(exportVarSpy).not.toHaveBeenCalledWith(
        "SECURITY_REVIEW_ENABLED",
        "true",
      );
      expect(candidatesSessionTag()).toEqual({
        name: "code-review",
        metadata: expect.objectContaining({
          pass: "candidates",
          reviewType: "code",
          securityReview: "false",
        }),
      });
    });
  }

  it("does not create a comment when automatic security review is skipped", async () => {
    const context = createAutomaticReviewContext(false, "true");
    const octokit = createAutomaticReviewOctokit(true);

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    expect(result).toEqual({
      skipped: true,
      reason: "security_review_exists",
      branchInfo: {
        baseBranch: "",
        currentBranch: "",
      },
      mcpTools: "",
    });
    expect(createCommentSpy).not.toHaveBeenCalled();
    expect(setOutputSpy).toHaveBeenCalledWith("run_code_review", "false");
    expect(setOutputSpy).toHaveBeenCalledWith("run_security_review", "false");
  });

  it("does not let Claude's security summary suppress Droid's review", async () => {
    const context = createAutomaticReviewContext(false, "true");
    const octokit = createAutomaticReviewOctokit(true, 209825114);

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    expect(result.skipped).toBeFalsy();
    expect(createCommentSpy).toHaveBeenCalledWith(
      octokit.rest,
      context,
      "security",
      DroidRunType.SecurityReview,
    );
    expect(setOutputSpy).toHaveBeenCalledWith("run_security_review", "true");
  });

  it.each([
    ["explicit true", "true"],
    ["omitted", undefined],
    ["empty", ""],
  ] as const)(
    "creates a review-only comment when security (%s) is deduplicated",
    async (_name, input) => {
      const context = createAutomaticReviewContext(true, input);
      const octokit = createAutomaticReviewOctokit(true);

      const result = await prepareTagExecution({
        context,
        octokit,
        githubToken: "token",
      });

      expect(result.skipped).toBeFalsy();
      expect(createCommentSpy).toHaveBeenCalledWith(
        octokit.rest,
        context,
        "default",
        DroidRunType.Review,
      );
      expect(setOutputSpy).toHaveBeenCalledWith("run_code_review", "true");
      expect(setOutputSpy).toHaveBeenCalledWith("run_security_review", "false");
      expect(exportVarSpy).not.toHaveBeenCalledWith(
        "SECURITY_REVIEW_ENABLED",
        "true",
      );
      expect(candidatesSessionTag()).toEqual({
        name: "code-review",
        metadata: expect.objectContaining({
          pass: "candidates",
          reviewType: "code",
          securityReview: "false",
        }),
      });
    },
  );

  it.each([
    ["explicit true", "true"],
    ["omitted", undefined],
    ["empty", ""],
  ] as const)(
    "creates a combined comment for automatic security (%s)",
    async (_name, input) => {
      const context = createAutomaticReviewContext(true, input);
      const octokit = createAutomaticReviewOctokit(false);

      const result = await prepareTagExecution({
        context,
        octokit,
        githubToken: "token",
      });

      expect(result.skipped).toBeFalsy();
      expect(createCommentSpy).toHaveBeenCalledWith(
        octokit.rest,
        context,
        "review_and_security",
        DroidRunType.Review,
      );
      expect(setOutputSpy).toHaveBeenCalledWith("run_code_review", "true");
      expect(setOutputSpy).toHaveBeenCalledWith("run_security_review", "true");
      expect(exportVarSpy).toHaveBeenCalledWith(
        "SECURITY_REVIEW_ENABLED",
        "true",
      );
      expect(candidatesSessionTag()).toEqual({
        name: "code-review",
        metadata: expect.objectContaining({
          pass: "candidates",
          reviewType: "code",
          securityReview: "true",
        }),
      });
    },
  );

  for (const manifest of ["action.yml", "prepare/action.yml"]) {
    it.each([
      ["inherited", undefined, false, true],
      ["empty", "", false, true],
      ["opted out", "false", false, false],
      ["explicitly enabled", "true", false, true],
      ["deduplicated", undefined, true, false],
    ] as const)(
      `runs ${manifest} inputs through preparation to the written prompt: %s`,
      async (_name, securityInput, hasSummary, expectedSecurity) => {
        const action = parse(
          readFileSync(path.join(import.meta.dir, "../..", manifest), "utf8"),
        );
        const context = createAutomaticReviewContext(
          true,
          securityInput ??
            action.inputs.automatic_security_review.default ??
            "",
        );
        const octokit = createAutomaticReviewOctokit(hasSummary);
        // Exercise the real prompt builder and filesystem. Only remote APIs,
        // checkout and MCP installation remain mocked by this suite.
        promptSpy.mockRestore();
        const logSpy = spyOn(console, "log").mockImplementation(() => {});
        try {
          expect(shouldTriggerTag(context)).toBe(true);
          const result = await prepare({
            context,
            octokit,
            githubToken: "token",
          });
          expect(result.skipped).toBeFalsy();
          expect(setOutputSpy).toHaveBeenCalledWith("run_code_review", "true");
          expect(setOutputSpy).toHaveBeenCalledWith(
            "run_security_review",
            String(expectedSecurity),
          );
          const prompt = await readFile(
            path.join(tmpDir, "droid-prompts/droid-prompt.txt"),
            "utf8",
          );
          expect(prompt).toContain("test-owner/test-repo");
          expect(prompt.includes("## Security Review (run concurrently)")).toBe(
            expectedSecurity,
          );
          expect(candidatesSessionTag()).toEqual({
            name: "code-review",
            metadata: expect.objectContaining({
              securityReview: String(expectedSecurity),
            }),
          });
        } finally {
          logSpy.mockRestore();
        }
      },
    );
  }

  it.each([
    ["@droid", DroidRunType.Default, "default", "run_code_review"],
    ["@droid review", DroidRunType.Review, "default", "run_code_review"],
    ["@droid fill", DroidRunType.Fill, "default", "droid_args"],
    [
      "@droid security",
      DroidRunType.SecurityReview,
      "security",
      "run_security_review",
    ],
  ] as const)(
    "does not hijack %s when both automatic inputs are omitted",
    async (body, runType, commentType, expectedOutput) => {
      createAutomaticReviewContext(false, undefined);
      delete process.env.AUTOMATIC_REVIEW;
      github.context.eventName = "issue_comment";
      github.context.payload = {
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        issue: { number: 7, pull_request: {} },
        comment: { id: 888, body, user: { login: "human-reviewer" } },
      };
      const context = parseGitHubContext();
      // A prior security summary must not suppress a manual command.
      const octokit = createAutomaticReviewOctokit(true);
      promptSpy.mockRestore();
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(shouldTriggerTag(context)).toBe(true);
        const result = await prepare({
          context,
          octokit,
          githubToken: "token",
        });
        expect(result.skipped).toBeFalsy();
        expect(createCommentSpy).toHaveBeenCalledWith(
          octokit.rest,
          context,
          commentType,
          runType,
        );
        expect(setOutputSpy).toHaveBeenCalledWith(
          expectedOutput,
          expect.any(String),
        );
        const prompt = await readFile(
          path.join(tmpDir, "droid-prompts/droid-prompt.txt"),
          "utf8",
        );
        expect(prompt).toContain("test-owner/test-repo");
        expect(prompt).not.toContain("## Security Review (run concurrently)");
        expect(prompt.includes("senior security engineer")).toBe(
          runType === DroidRunType.SecurityReview,
        );
      } finally {
        logSpy.mockRestore();
      }
    },
  );
});
