import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import * as contextModule from "../../src/github/context";
import * as runtime from "../../src/prepare/review-runtime";
import * as token from "../../src/github/token";
import * as client from "../../src/github/api/client";
import * as permissions from "../../src/github/validation/permissions";
import * as actor from "../../src/github/validation/actor";
import * as reviewConfig from "../../src/prepare/review-config";
import * as tag from "../../src/tag";
import * as preparation from "../../src/prepare";
import * as collect from "../../src/entrypoints/collect-inputs";
import { run } from "../../src/entrypoints/prepare";
import {
  automaticReviewSkipReason,
  resolveReviewUxConfig,
} from "../../src/core/review/config";
import { isManualReviewRequest } from "../../src/github/utils/review-intent";
import type { GitHubContext } from "../../src/github/context";
import { createMockAutomationContext, createMockContext } from "../mockContext";

const ENV_KEYS = [
  "RISK_STEPS_AVAILABLE",
  "AUTOMATIC_RISK_ASSESSMENT",
  "RISK_ASSESSMENT",
  "RUN_MODE",
  "RISK_PR_NUMBER",
  "RISK_DRY_RUN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "SCOPE_APP_TOKEN",
  "OVERRIDE_GITHUB_TOKEN",
] as const;

const COMMENT_ID = 4242;
const pullRequest = (action: string, draft = false) =>
  createMockContext({
    eventName: "pull_request",
    eventAction: action,
    isPR: true,
    entityNumber: 7,
    // A copy: prepare writes to its context's inputs.
    inputs: {},
    payload: {
      action,
      pull_request: { number: 7, draft, body: "" },
    } as any,
  });
const prComment = (body: string) =>
  createMockContext({
    eventName: "issue_comment",
    eventAction: "created",
    isPR: true,
    entityNumber: 7,
    inputs: {},
    payload: {
      action: "created",
      issue: { number: 7, pull_request: { url: "https://example.test" } },
      comment: { id: COMMENT_ID, body, created_at: "2026-01-01T00:00:00Z" },
    } as any,
  });

describe("prepare's run plan", () => {
  let events: string[];
  let outputs: Record<string, string>;
  let frozen: Array<readonly string[] | undefined>;
  let reactions: unknown[];
  let context: GitHubContext;
  let reviewInputs: Record<string, string>;
  let hasWrite: boolean;
  let configFailure: Error | undefined;
  let preparedContext: GitHubContext | undefined;
  let saved: Record<string, string | undefined>;
  const spies: Array<{ mockRestore(): void }> = [];

  beforeEach(() => {
    events = [];
    outputs = {};
    frozen = [];
    reactions = [];
    reviewInputs = {};
    hasWrite = true;
    configFailure = undefined;
    preparedContext = undefined;
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.RISK_STEPS_AVAILABLE = "true";
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://token.example.test";

    const octokit = {
      rest: {
        reactions: {
          createForIssueComment: async (request: unknown) => {
            events.push("reaction");
            reactions.push(request);
            return { status: 201, data: { id: 1 } };
          },
        },
      },
    };
    spies.push(
      spyOn(collect, "collectActionInputsPresence").mockImplementation(
        () => {},
      ),
      spyOn(contextModule, "parseGitHubContext").mockImplementation(
        () => context,
      ),
      spyOn(runtime, "freezeReviewRuntime").mockImplementation(
        async (kinds?: readonly string[]) => {
          frozen.push(kinds);
          return {};
        },
      ),
      spyOn(token, "setupGitHubToken").mockResolvedValue("synthetic-token"),
      spyOn(client, "createOctokit").mockImplementation(
        () => octokit as unknown as ReturnType<typeof client.createOctokit>,
      ),
      spyOn(permissions, "checkWritePermissions").mockImplementation(
        async () => {
          events.push("write");
          return hasWrite;
        },
      ),
      spyOn(actor, "checkHumanActor").mockImplementation(async () => {
        events.push("actor");
      }),
      spyOn(reviewConfig, "initializeReviewConfig").mockImplementation(
        async (target) => {
          events.push("config");
          if (configFailure) throw configFailure;
          target.inputs.reviewConfig = resolveReviewUxConfig({
            inputs: reviewInputs,
          });
          target.inputs.automaticReview =
            target.inputs.reviewConfig.automatic_review;
        },
      ),
      spyOn(tag, "shouldTriggerTag").mockImplementation(() => {
        events.push("trigger");
        return true;
      }),
      spyOn(preparation, "prepare").mockImplementation(async (options) => {
        events.push("tag");
        preparedContext = options.context;
        return { branchInfo: { baseBranch: "", currentBranch: "" } } as any;
      }),
      spyOn(core, "setOutput").mockImplementation((name, value) => {
        events.push(`output:${name}`);
        outputs[name] = String(value);
      }),
      spyOn(core, "error").mockImplementation((message, properties) => {
        events.push(`error:${properties?.title ?? ""}:${String(message)}`);
      }),
      spyOn(core, "warning").mockImplementation((message) => {
        events.push(`warning:${String(message)}`);
      }),
      spyOn(core, "setFailed").mockImplementation((message) => {
        events.push(`failed:${String(message)}`);
      }),
      spyOn(core, "exportVariable").mockImplementation(() => {}),
      spyOn(process, "exit").mockImplementation((() => {
        events.push("exit");
      }) as never),
      spyOn(console, "log").mockImplementation(() => {}),
    );
  });

  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const riskFrozen = () =>
    frozen.some((kinds) => kinds === runtime.RISK_RUNTIME_KINDS);

  it("leaves a review-only install exactly as it was", async () => {
    context = pullRequest("synchronize");
    await run();
    expect(outputs).toMatchObject({
      run_review: "auto",
      run_risk: "false",
      risk_manual: "false",
      contains_trigger: "true",
    });
    expect(riskFrozen()).toBe(false);
    expect(events).toContain("tag");
  });

  it("exits before tag setup with contains_trigger=false when the plan turns the review off", async () => {
    process.env.AUTOMATIC_RISK_ASSESSMENT = "true";
    process.env.RUN_MODE = "risk";
    context = pullRequest("synchronize");
    await run();
    expect(outputs).toMatchObject({
      run_review: "off",
      run_risk: "true",
      risk_manual: "false",
      contains_trigger: "false",
    });
    expect(outputs.run_reason).toContain("run: risk");
    expect(events).not.toContain("trigger");
    expect(events).not.toContain("tag");
    expect(riskFrozen()).toBe(true);
  });

  it("checks a comment's actor for write access before it plans a manual assessment", async () => {
    context = prComment("@droid risk");
    await run();
    expect(outputs).toMatchObject({
      run_review: "off",
      run_risk: "true",
      risk_manual: "true",
      contains_trigger: "false",
    });
    expect(events.indexOf("write")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("write")).toBeLessThan(
      events.indexOf("output:run_risk"),
    );
    expect(events.indexOf("actor")).toBeLessThan(
      events.indexOf("output:run_risk"),
    );
    expect(reactions).toEqual([
      {
        owner: "test-owner",
        repo: "test-repo",
        comment_id: COMMENT_ID,
        content: "eyes",
      },
    ]);
    expect(events).not.toContain("trigger");
    expect(events).not.toContain("tag");
  });

  // The prepare sub-action hands off to the caller's steps and has no risk
  // steps, so a risk request there stays a tag-mode command.
  it("plans no assessment where the action has no risk steps", async () => {
    delete process.env.RISK_STEPS_AVAILABLE;
    process.env.AUTOMATIC_RISK_ASSESSMENT = "true";
    process.env.RISK_PR_NUMBER = "31";
    context = prComment("@droid risk");
    await run();
    expect(outputs).toMatchObject({
      run_review: "auto",
      run_risk: "false",
      contains_trigger: "true",
    });
    expect(events).toContain("tag");
    expect(riskFrozen()).toBe(false);
    expect(reactions).toHaveLength(0);
  });

  it("assesses nothing for a comment whose actor cannot write", async () => {
    hasWrite = false;
    context = prComment("@droid risk");
    await run();
    expect(events).toContain("exit");
    expect(outputs.run_risk).toBe("false");
    expect(outputs.risk_manual).toBe("false");
    expect(reactions).toHaveLength(0);
  });

  it("assesses nothing for a comment from a bot that is not allowed", async () => {
    spies.push(
      spyOn(actor, "checkHumanActor").mockImplementation(async () => {
        throw new Error("Workflow initiated by non-human actor");
      }),
    );
    context = prComment("@droid risk");
    await run();
    expect(events).toContain("exit");
    expect(outputs.run_risk).toBe("false");
    expect(reactions).toHaveLength(0);
  });

  it("reviews as a manual request with run: both, past the event allowlist", async () => {
    process.env.AUTOMATIC_RISK_ASSESSMENT = "true";
    process.env.RUN_MODE = "both";
    reviewInputs = { review_auto_triggers: "opened,reopened,ready_for_review" };
    context = pullRequest("synchronize");
    await run();
    expect(outputs).toMatchObject({ run_review: "manual", run_risk: "true" });
    const prepared = preparedContext!;
    const skip = (manual: boolean) =>
      automaticReviewSkipReason({
        config: prepared.inputs.reviewConfig!,
        draft: false,
        eventAction: prepared.eventAction,
        manual,
      });
    expect(skip(false)).toBe("automatic trigger synchronize is disabled");
    expect(skip(isManualReviewRequest(prepared))).toBeNull();
  });

  it("keeps run: auto's review subject to the allowlist", async () => {
    process.env.AUTOMATIC_RISK_ASSESSMENT = "true";
    context = pullRequest("synchronize");
    await run();
    expect(outputs).toMatchObject({ run_review: "auto", run_risk: "true" });
    expect(isManualReviewRequest(preparedContext!)).toBe(false);
  });

  it("drops the assessment with an error when the job cannot mint an OIDC token", async () => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    process.env.AUTOMATIC_RISK_ASSESSMENT = "true";
    context = pullRequest("opened");
    await run();
    expect(outputs.run_risk).toBe("false");
    expect(outputs.risk_setup_error).toContain("id-token: write");
    expect(
      events.some((event) =>
        event.startsWith("error:Risk assessment needs id-token: write:"),
      ),
    ).toBe(true);
    // The review still runs.
    expect(events).toContain("tag");
    expect(events).not.toContain("exit");
  });

  it("needs no OIDC token for a dry run", async () => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    process.env.AUTOMATIC_RISK_ASSESSMENT = "true";
    process.env.RISK_DRY_RUN = "true";
    context = pullRequest("opened");
    await run();
    expect(outputs).toMatchObject({ run_risk: "true", risk_setup_error: "" });
    expect(events.some((event) => event.startsWith("error:"))).toBe(false);
  });

  it.each([
    ["a comment", () => prComment("thanks")],
    ["a dispatch", () => createMockAutomationContext()],
  ])(
    "freezes the risk scripts for %s without automatic_risk_assessment",
    async (_name, build) => {
      context = build();
      await run();
      expect(riskFrozen()).toBe(true);
      expect(frozen[0]).toBeUndefined();
    },
  );

  it("assesses a dispatch with risk_pr_number as a manual request", async () => {
    process.env.RISK_PR_NUMBER = "31";
    context = createMockAutomationContext();
    await run();
    expect(outputs).toMatchObject({
      run_review: "off",
      run_risk: "true",
      risk_manual: "true",
      contains_trigger: "false",
    });
    expect(events).not.toContain("write");
  });

  it("reads the deprecated risk_assessment as automatic_risk_assessment, with a warning", async () => {
    process.env.RISK_ASSESSMENT = "true";
    context = pullRequest("opened");
    await run();
    expect(outputs.run_risk).toBe("true");
    expect(events).toContain(
      "warning:risk_assessment is deprecated; use automatic_risk_assessment",
    );
    expect(riskFrozen()).toBe(true);
  });

  it("fails prepare on an unknown run value", async () => {
    process.env.RUN_MODE = "sometimes";
    context = pullRequest("opened");
    await run();
    expect(events).toContain("exit");
    expect(outputs.prepare_error).toContain(
      "The run input must be auto, review, risk or both",
    );
    expect(outputs.run_risk).toBeUndefined();
  });

  it("still asks Factory, as a failed run, when prepare fails before planning", async () => {
    process.env.AUTOMATIC_RISK_ASSESSMENT = "true";
    configFailure = new Error("synthetic configuration failure");
    context = pullRequest("synchronize");
    await run();
    expect(events).toContain("exit");
    expect(outputs).toMatchObject({
      run_risk: "true",
      risk_manual: "false",
      prepare_error: "synthetic configuration failure",
    });
  });
});
