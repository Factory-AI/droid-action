import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { prepareTagExecution } from "../../src/tag";
import { shouldTriggerTag } from "../../src/tag";
import { prepare } from "../../src/prepare";
import { createMockContext as sharedMockContext } from "../mockContext";
import * as createInitial from "../../src/github/operations/comments/create-initial";
import * as mcpInstaller from "../../src/mcp/install-mcp-server";
import * as actorValidation from "../../src/github/validation/actor";
import * as checkout from "../../src/core/worker/checkout";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { parseGitHubContext } from "../../src/github/context";
import { DroidRunType } from "../../src/run-type";
import * as lifecycle from "../../src/github/operations/review-lifecycle";
import {
  encodeReviewState,
  SUMMARY_MARKER,
} from "../../src/core/review/markers";

const realPrepareLifecycle = lifecycle.prepareReviewLifecycle;
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const createMockContext = (...args: Parameters<typeof sharedMockContext>) =>
  structuredClone(sharedMockContext(...args));
const securityReceipt = (head = HEAD) =>
  `${SUMMARY_MARKER}\n${encodeReviewState({ head, findings: [], securityReviewedHead: head })}`;

describe("review command integration", () => {
  const managedKey = (key: string) =>
    /^(REVIEW_|SECURITY_|FAIL_ON_|WORKFLOW_GITHUB_TOKEN$)/.test(key);
  let savedEnvironment: Map<string, string | undefined>;
  let originalGitHubContext: Pick<
    typeof github.context,
    "eventName" | "payload" | "actor"
  >;
  let tmpDir: string;
  let graphqlSpy: ReturnType<typeof spyOn>;
  let createCommentSpy: ReturnType<typeof spyOn>;
  let mcpSpy: ReturnType<typeof spyOn>;
  let actorSpy: ReturnType<typeof spyOn>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let exportVarSpy: ReturnType<typeof spyOn>;
  let checkoutSpies: ReturnType<typeof spyOn>[];
  let fetchSpy: ReturnType<typeof spyOn>;
  let lifecycleSpy: ReturnType<typeof spyOn>;
  let stickyBodies: string[];

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
    return structuredClone(parseGitHubContext());
  }

  function createAutomaticReviewOctokit(
    hasExistingSecurityReview: boolean,
    botId = 138933559,
    receiptBody = securityReceipt(),
  ) {
    const branchData = {
      viewer: { login: "factory-droid[bot]" },
      repository: {
        pullRequest: {
          baseRefName: "main",
          headRefName: "feature/review",
          headRefOid: HEAD,
          title: "Review fixture",
        },
      },
    };
    const octokit = {
      rest: {
        issues: {
          listComments: () =>
            Promise.resolve({
              data: hasExistingSecurityReview
                ? [
                    // Prior code-review memory must not become a same-head
                    // incremental skip in this security-input wiring fixture.
                    {
                      id: 202,
                      user: {
                        id: 138933559,
                        login: "factory-droid[bot]",
                        type: "Bot",
                      },
                      body: `${SUMMARY_MARKER}\n${encodeReviewState({ head: OLD, findings: [] })}`,
                    },
                    {
                      id: 101,
                      user: {
                        id: botId,
                        login:
                          botId === 138933559
                            ? "factory-droid[bot]"
                            : "claude[bot]",
                        type: "Bot",
                      },
                      body: receiptBody,
                    },
                  ]
                : [],
            }),
        },
      },
      graphql: async () => structuredClone(branchData),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockImplementation(async () =>
      structuredClone(branchData),
    );
    return octokit;
  }

  beforeEach(async () => {
    savedEnvironment = new Map(
      [
        ...Object.keys(process.env).filter(managedKey),
        "RUNNER_TEMP",
        "GITHUB_WORKSPACE",
        "DROID_ARGS",
        "DROID_EXEC_RUN_TYPE",
        "DROID_BOT_LOGIN",
        "FACTORY_API_KEY",
        "GITHUB_ENV",
        "GITHUB_STEP_SUMMARY",
        "GITHUB_REPOSITORY",
        "GITHUB_RUN_ID",
        "GITHUB_RUN_ATTEMPT",
        "AUTOMATIC_REVIEW",
        "AUTOMATIC_SECURITY_REVIEW",
      ].map((key) => [key, process.env[key]]),
    );
    for (const key of savedEnvironment.keys()) delete process.env[key];
    originalGitHubContext = {
      eventName: github.context.eventName,
      payload: github.context.payload,
      actor: github.context.actor,
    };
    stickyBodies = [];
    lifecycleSpy = spyOn(
      lifecycle,
      "prepareReviewLifecycle",
    ).mockImplementation(async (options) => {
      // Keep the real lifecycle and renderer. Mock GitHub at its boundary.
      const rest = options.octokit.rest as any;
      rest.issues ??= {};
      let liveBody = "";
      rest.issues.listComments ??= async () => ({ data: [] });
      rest.issues.createComment = async (params: { body: string }) => {
        stickyBodies.push(params.body);
        liveBody = params.body;
        return { data: { id: 202, body: params.body } };
      };
      rest.issues.updateComment = async (params: { body: string }) => {
        stickyBodies.push(params.body);
        liveBody = params.body;
        return { data: { id: 202, body: params.body } };
      };
      rest.issues.getComment = async () => ({
        data: {
          id: 202,
          body: liveBody,
          user: { id: 138933559, login: "factory-droid[bot]", type: "Bot" },
          issue_url: `https://api.github.com/repos/${options.context.repository.full_name}/issues/${options.context.entityNumber}`,
        },
      });
      rest.paginate ??= async (
        list: (parameters: unknown) => Promise<{ data: unknown[] }>,
        parameters: unknown,
      ) => (await list(parameters)).data;
      rest.pulls ??= {};
      rest.pulls.listReviewComments ??= async () => ({ data: [] });
      rest.pulls.get ??= async () => ({
        data: {
          title: "Review fixture",
          body: "",
          head: { sha: options.headSha },
          base: { sha: OLD },
        },
      });
      rest.checks = {
        create: async (input: unknown) => {
          expect(input).toEqual(
            expect.objectContaining({
              owner: options.context.repository.owner,
              repo: options.context.repository.repo,
              head_sha: options.headSha,
              external_id: `${options.context.runId}:2`,
            }),
          );
          return { data: { id: 303 } };
        },
        update: async () => ({ data: { id: 303 } }),
      };
      rest.reactions = {
        createForIssue: async () => ({ data: { id: 404 } }),
        createForIssueComment: async () => ({ data: { id: 404 } }),
        deleteForIssue: async () => ({}),
        deleteForIssueComment: async () => ({}),
      };
      return realPrepareLifecycle(options);
    });
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "review-int-"));
    process.env.RUNNER_TEMP = tmpDir;
    process.env.GITHUB_WORKSPACE = tmpDir;
    process.env.REVIEW_BASE_SHA = OLD;
    process.env.DROID_ARGS = "";
    process.env.GITHUB_REPOSITORY = "test-owner/test-repo";
    process.env.FACTORY_API_KEY = "test-factory-api-key";
    process.env.GITHUB_RUN_ID = "1234567890";
    process.env.GITHUB_RUN_ATTEMPT = "2";
    delete process.env.SECURITY_REVIEW_ENABLED;
    delete process.env.DROID_EXEC_RUN_TYPE;
    delete process.env.GITHUB_ENV;

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
    // The suite has no checkout. Everything else that leaves a review's
    // input runs: the lifecycle, the comments, and the input's builder.
    checkoutSpies = [
      spyOn(checkout, "fetchPullRequest").mockResolvedValue(),
      spyOn(checkout, "fetchCommits").mockResolvedValue(),
      spyOn(checkout, "hasCommit").mockResolvedValue(true),
    ];
    setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    exportVarSpy = spyOn(core, "exportVariable").mockImplementation(
      (name, value) => {
        if (name === "SECURITY_REVIEW_ENABLED")
          process.env[name] = String(value);
      },
    );
  });

  afterEach(async () => {
    lifecycleSpy.mockRestore();
    graphqlSpy?.mockRestore();
    createCommentSpy.mockRestore();
    mcpSpy.mockRestore();
    actorSpy.mockRestore();
    for (const spy of checkoutSpies) spy.mockRestore();
    setOutputSpy.mockRestore();
    exportVarSpy.mockRestore();
    fetchSpy.mockRestore();

    await rm(tmpDir, { recursive: true, force: true });
    Object.assign(github.context, originalGitHubContext);
    for (const key of Object.keys(process.env))
      if (managedKey(key) && !savedEnvironment.has(key))
        delete process.env[key];
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const inputPath = () => path.join(tmpDir, "droid-prompts/review_input.json");
  async function writtenInput(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(inputPath(), "utf8"));
  }
  function expectStickyLifecycle(
    context: Parameters<typeof prepareTagExecution>[0]["context"],
    securityOnly = false,
  ): void {
    expect(lifecycleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        ...(securityOnly ? { securityOnly: true } : {}),
      }),
    );
    expect(
      stickyBodies.some(
        (body) =>
          body.includes(SUMMARY_MARKER) &&
          body.includes("[!NOTE]") &&
          body.includes("Droid is reviewing"),
      ),
    ).toBe(true);
    expect(createCommentSpy).not.toHaveBeenCalled();
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
              title: "Review fixture",
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
          title: "Review fixture",
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
    expect(await writtenInput()).toMatchObject({
      repo: "test-owner/test-repo",
      prNumber: 7,
      head: "def456",
      base: OLD,
      baseRef: "main",
      headRef: "feature/review",
      security: false,
    });
    expect(process.env.DROID_EXEC_RUN_TYPE).toBe(DroidRunType.Review);
    expect(exportVarSpy).not.toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      DroidRunType.Review,
    );
    expectStickyLifecycle(context);

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
    expect(process.env.DROID_EXEC_RUN_TYPE).toBe(DroidRunType.Default);
    expect(exportVarSpy).not.toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      DroidRunType.Default,
    );
    expectStickyLifecycle(context);
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
    expectStickyLifecycle(context);
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
              title: "Review fixture",
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
          title: "Review fixture",
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
    // A security-only review is its judge's, not a flag on a code review.
    expect(await writtenInput()).toMatchObject({
      head: "abc123",
      security: false,
    });
    expect(process.env.DROID_EXEC_RUN_TYPE).toBe(DroidRunType.SecurityReview);
    expect(exportVarSpy).not.toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      DroidRunType.SecurityReview,
    );
    expectStickyLifecycle(context, true);

    const runCodeReviewCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "run_code_review",
    ) as [string, string] | undefined;
    const runSecurityReviewCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "run_security_review",
    ) as [string, string] | undefined;

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
      expectStickyLifecycle(context);
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
      expect(await writtenInput()).toMatchObject({ security: false });
    });
  }

  it("renders the skipped lifecycle when automatic security review already exists", async () => {
    const context = createAutomaticReviewContext(false, "true");
    const octokit = createAutomaticReviewOctokit(true);

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("Security review already exists on this PR.");
    expect(
      stickyBodies.some(
        (body) =>
          body.includes(SUMMARY_MARKER) && body.includes("[!IMPORTANT]"),
      ),
    ).toBe(true);
    expect(existsSync(inputPath())).toBe(false);
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
    expectStickyLifecycle(context, true);
    expect(setOutputSpy).toHaveBeenCalledWith("run_security_review", "true");
  });

  it.each([
    ["display-only", "## Security Review Summary"],
    ["stale", securityReceipt(OLD)],
    ["quoted", `\`\`\`md\n${securityReceipt()}\n\`\`\``],
    [
      "missing completion",
      `${SUMMARY_MARKER}\n${encodeReviewState({ head: HEAD, findings: [] })}`,
    ],
  ])("does not deduplicate a %s security receipt", async (_name, body) => {
    const context = createAutomaticReviewContext(false, "true");
    const octokit = createAutomaticReviewOctokit(true, 138933559, body);
    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });
    expect(result.skipped).toBeFalsy();
    expectStickyLifecycle(context, true);
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
      expectStickyLifecycle(context);
      expect(setOutputSpy).toHaveBeenCalledWith("run_code_review", "true");
      expect(setOutputSpy).toHaveBeenCalledWith("run_security_review", "false");
      expect(exportVarSpy).not.toHaveBeenCalledWith(
        "SECURITY_REVIEW_ENABLED",
        "true",
      );
      expect(await writtenInput()).toMatchObject({ security: false });
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
      expectStickyLifecycle(context);
      expect(setOutputSpy).toHaveBeenCalledWith("run_code_review", "true");
      expect(setOutputSpy).toHaveBeenCalledWith("run_security_review", "true");
      expect(exportVarSpy).toHaveBeenCalledWith(
        "SECURITY_REVIEW_ENABLED",
        "true",
      );
      expect(await writtenInput()).toMatchObject({ security: true });
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
      `runs ${manifest} inputs through preparation to the written input: %s`,
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
          expect(await writtenInput()).toMatchObject({
            repo: "test-owner/test-repo",
            security: expectedSecurity,
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
      const context = structuredClone(parseGitHubContext());
      // A prior security summary must not suppress a manual command.
      const octokit = createAutomaticReviewOctokit(true);
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(shouldTriggerTag(context)).toBe(true);
        const result = await prepare({
          context,
          octokit,
          githubToken: "token",
        });
        expect(result.skipped).toBeFalsy();
        if (runType === DroidRunType.Fill) {
          expect(createCommentSpy).toHaveBeenCalledWith(
            octokit.rest,
            context,
            commentType,
            runType,
          );
        } else {
          expectStickyLifecycle(
            context,
            runType === DroidRunType.SecurityReview,
          );
        }
        expect(setOutputSpy).toHaveBeenCalledWith(
          expectedOutput,
          expect.any(String),
        );
        if (runType === DroidRunType.Fill) {
          expect(
            await readFile(
              path.join(tmpDir, "droid-prompts/droid-prompt.txt"),
              "utf8",
            ),
          ).toContain("test-owner/test-repo");
          expect(existsSync(inputPath())).toBe(false);
        } else {
          expect(await writtenInput()).toMatchObject({
            repo: "test-owner/test-repo",
            security: false,
          });
        }
      } finally {
        logSpy.mockRestore();
      }
    },
  );
});
