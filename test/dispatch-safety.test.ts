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
import * as contextModule from "../src/github/context";
import * as client from "../src/github/api/client";
import * as pr from "../src/github/data/pr-fetcher";
import * as checkout from "../src/github/data/pr-checkout";
import * as artifacts from "../src/github/data/review-artifacts";
import * as prompt from "../src/create-prompt";
import * as mcp from "../src/mcp/install-mcp-server";
import * as lifecycle from "../src/github/operations/review-lifecycle";
import * as config from "../src/prepare/review-config";
import * as runtime from "../src/prepare/review-runtime";
import * as policy from "../src/utils/model-policy";
import * as actor from "../src/github/validation/actor";
import * as review from "../src/tag/commands/review";
import * as security from "../src/tag/commands/security-review";
import { prepareTagExecution } from "../src/tag";
import { run } from "../src/entrypoints/generate-review-prompt";
import { resolveReviewUxConfig } from "../src/core/review/config";
import {
  decodeReviewState,
  encodeReviewState,
  SUMMARY_MARKER,
} from "../src/core/review/markers";
import { createMockContext } from "./mockContext";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
let saved: NodeJS.ProcessEnv;
let context: ReturnType<typeof createMockContext>;
let kit: any;
let lifecycleSpy: ReturnType<typeof spyOn>;
let promptSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  saved = { ...process.env };
  for (const key of Object.keys(process.env))
    if (
      /^(REVIEW_|SECURITY_|DROID_|GITHUB_ENV|WORKFLOW_GITHUB_TOKEN)/.test(key)
    )
      delete process.env[key];
  Object.assign(process.env, {
    GITHUB_TOKEN: "test-only",
    DROID_COMMENT_ID: "55",
  });
  context = createMockContext({
    eventName: "pull_request",
    eventAction: "edited",
    isPR: true,
    payload: {
      pull_request: { body: "@droid review", draft: true },
      changes: { body: { from: "Original description" } },
    } as any,
    inputs: { reviewConfig: resolveReviewUxConfig() },
  });
  kit = {
    rest: { issues: { listComments: async () => ({ data: [] }) } },
    graphql: async () => ({ viewer: { login: "factory-droid[bot]" } }),
  };
  spyOn(core, "setOutput").mockImplementation(() => {});
  spyOn(core, "exportVariable").mockImplementation(() => {});
  spyOn(core, "setFailed").mockImplementation((message) => {
    throw new Error(String(message));
  });
  spyOn(client, "createOctokit").mockReturnValue(kit);
  spyOn(contextModule, "parseGitHubContext").mockImplementation(() => context);
  spyOn(pr, "fetchPRBranchData").mockResolvedValue({
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: HEAD,
    isFork: false,
    title: "test",
    body: "",
  } as any);
  spyOn(checkout, "preparePullRequestHead").mockResolvedValue("HEAD");
  spyOn(artifacts, "computeReviewArtifacts").mockResolvedValue({
    diffPath: "/tmp/diff",
    commentsPath: "/tmp/comments",
    descriptionPath: "/tmp/description",
  });
  lifecycleSpy = spyOn(lifecycle, "prepareReviewLifecycle").mockImplementation(
    async (options) => ({
      commentId: 55,
      state: { head: OLD, findings: [] },
      skipReason: options.skipReason ?? undefined,
      run: {} as any,
    }),
  );
  spyOn(lifecycle, "readReviewLifecycle").mockResolvedValue(null);
  promptSpy = spyOn(prompt, "createPrompt").mockResolvedValue();
  spyOn(mcp, "prepareMcpTools").mockResolvedValue("{}");
  spyOn(config, "initializeReviewConfig").mockResolvedValue();
  spyOn(runtime, "freezeReviewRuntime").mockResolvedValue({});
  spyOn(policy, "applyModelPolicyFallback").mockResolvedValue({
    model: "test-model",
  });
  spyOn(actor, "checkHumanActor").mockResolvedValue();
});
afterEach(() => {
  mock.restore();
  for (const key of Object.keys(process.env))
    if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("real preparation adapters distinguish manual PR-body requests", () => {
  for (const mode of [
    "code",
    "security",
    "standalone-code",
    "standalone-security",
  ]) {
    it(`${mode}: edited draft mention bypasses only automatic gates`, async () => {
      if (mode.endsWith("security"))
        (context.payload as any).pull_request.body = "@droid security";
      if (mode.startsWith("standalone")) {
        process.env.REVIEW_TYPE = mode.endsWith("security")
          ? "security"
          : "code";
        await run();
      } else if (mode === "security") {
        await security.prepareSecurityReviewMode({
          context,
          octokit: kit,
          githubToken: "test-only",
        });
      } else {
        await review.prepareReviewMode({
          context,
          octokit: kit,
          githubToken: "test-only",
        });
      }
      expect(lifecycleSpy.mock.calls[0]?.[0].skipReason).toBeUndefined();
      expect(promptSpy).toHaveBeenCalledTimes(1);
    });
  }
  it("does not exempt an automatic edited draft because its description contains a command", async () => {
    context.inputs.automaticReview = true;
    await review.prepareReviewMode({
      context,
      octokit: kit,
      githubToken: "test-only",
    });
    expect(lifecycleSpy.mock.calls[0]?.[0].skipReason).toBeDefined();
    expect(promptSpy).not.toHaveBeenCalled();
  });
  it("does not treat an unmentioned draft event as an explicit request", async () => {
    (context.payload as any).pull_request.body = "ordinary PR description";
    await review.prepareReviewMode({
      context,
      octokit: kit,
      githubToken: "test-only",
    });
    expect(lifecycleSpy.mock.calls[0]?.[0].skipReason).toBeDefined();
  });
  it("standalone manual security forces full despite ordinary same-head review memory", async () => {
    context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: { comment: { body: "@droid security" } } as any,
      inputs: { reviewConfig: resolveReviewUxConfig() },
    });
    process.env.REVIEW_TYPE = "security";
    await run();
    expect(lifecycleSpy.mock.calls[0]?.[0].full).toBe(true);
  });
  it("manual PR-body security has the same full intent as manual comment security", async () => {
    (context.payload as any).pull_request.body = "@droid security";
    await security.prepareSecurityReviewMode({
      context,
      octokit: kit,
      githubToken: "test-only",
    });
    expect(lifecycleSpy.mock.calls[0]?.[0].full).toBe(true);
  });
});

describe("mode-specific manual requests do not inherit unrelated automatic flags", () => {
  it("a request added to a previously empty body is manual", async () => {
    (context.payload as any).changes.body.from = null;
    await review.prepareReviewMode({
      context,
      octokit: kit,
      githubToken: "test-only",
    });
    expect(lifecycleSpy.mock.calls[0]?.[0].skipReason).toBeUndefined();
  });
  it("manual security stays manual when only automatic code review is enabled", async () => {
    context.inputs.automaticReview = true;
    (context.payload as any).pull_request.body = "@droid security";
    await security.prepareSecurityReviewMode({
      context,
      octokit: kit,
      githubToken: "test-only",
    });
    expect(lifecycleSpy.mock.calls[0]?.[0].skipReason).toBeUndefined();
    expect(lifecycleSpy.mock.calls[0]?.[0].full).toBe(true);
  });
  it("manual code review stays manual when only automatic security review is enabled", async () => {
    context.inputs.automaticSecurityReview = true;
    await review.prepareReviewMode({
      context,
      octokit: kit,
      githubToken: "test-only",
    });
    expect(lifecycleSpy.mock.calls[0]?.[0].skipReason).toBeUndefined();
  });
  it("a title-only edit does not refresh a persistent body request", async () => {
    (context.payload as any).changes = { title: { from: "Old title" } };
    await review.prepareReviewMode({
      context,
      octokit: kit,
      githubToken: "test-only",
    });
    expect(lifecycleSpy.mock.calls[0]?.[0].skipReason).toBeDefined();
  });
  it("an unrelated body edit does not refresh the same previous command", async () => {
    (context.payload as any).changes.body.from =
      "@droid review\nPrevious description";
    await review.prepareReviewMode({
      context,
      octokit: kit,
      githubToken: "test-only",
    });
    expect(lifecycleSpy.mock.calls[0]?.[0].skipReason).toBeDefined();
  });
  for (const eventAction of ["synchronize", "reopened"]) {
    it(`${eventAction} does not refresh a persistent body request`, async () => {
      context.eventAction = eventAction;
      await review.prepareReviewMode({
        context,
        octokit: kit,
        githubToken: "test-only",
      });
      expect(lifecycleSpy.mock.calls[0]?.[0].skipReason).toBeDefined();
    });
  }
  for (const mode of ["code", "security"]) {
    it(`tag dispatch honors explicit ${mode} instead of the other mode's automatic flag`, async () => {
      context.inputs.automaticReview = mode === "security";
      context.inputs.automaticSecurityReview = mode === "code";
      (context.payload as any).pull_request.body =
        mode === "security" ? "@droid security" : "@droid review";
      const result = {
        branchInfo: { baseBranch: "main", currentBranch: "feature" },
        mcpTools: "",
      };
      const codeSpy = spyOn(review, "prepareReviewMode").mockResolvedValue(
        result,
      );
      const securitySpy = spyOn(
        security,
        "prepareSecurityReviewMode",
      ).mockResolvedValue(result);
      await prepareTagExecution({
        context,
        octokit: kit,
        githubToken: "test-only",
      });
      expect(mode === "code" ? codeSpy : securitySpy).toHaveBeenCalledTimes(1);
      expect(mode === "code" ? securitySpy : codeSpy).not.toHaveBeenCalled();
    });
  }
});

describe("actual tag dispatcher consumes owned head-bound security completion", () => {
  async function dispatch(
    body: string,
    user = { id: 138933559, login: "factory-droid[bot]" },
  ) {
    context = createMockContext({
      eventName: "pull_request",
      eventAction: "synchronize",
      isPR: true,
      inputs: { automaticSecurityReview: true },
    });
    kit.rest.issues.listComments = async () => ({
      data: [{ id: 51, body, user }],
    });
    const spy = spyOn(security, "prepareSecurityReviewMode").mockResolvedValue({
      branchInfo: { baseBranch: "main", currentBranch: "feature" },
      mcpTools: "",
    });
    await prepareTagExecution({
      context,
      octokit: kit,
      githubToken: "test-only",
    });
    return spy.mock.calls[0]?.[0].skipReason;
  }
  const receipt = (head = HEAD) =>
    `${SUMMARY_MARKER}\n${encodeReviewState({ head, findings: [], securityReviewedHead: head } as any)}`;
  it("recognizes machine receipt with omitted details/description-only state note", async () => {
    expect(await dispatch(receipt())).toContain("already exists");
  });
  it("does not reuse a receipt from a previous head", async () => {
    expect(await dispatch(receipt(OLD))).toBeUndefined();
  });
  it("does not trust a human-authored receipt", async () => {
    expect(
      await dispatch(receipt(), { id: 77, login: "human" }),
    ).toBeUndefined();
  });
  it("does not trust fenced marker examples even in a bot comment", async () => {
    expect(await dispatch(`\`\`\`md\n${receipt()}\n\`\`\``)).toBeUndefined();
  });
  it("keeps legacy ordinary state valid without inventing security completion", async () => {
    const legacy = `${SUMMARY_MARKER}\n${encodeReviewState({ head: HEAD, findings: [] })}`;
    expect(decodeReviewState(legacy)?.head).toBe(HEAD);
    expect(await dispatch(legacy)).toBeUndefined();
  });
  it("still applies the human-actor guard before looking up completion", async () => {
    spyOn(actor, "checkHumanActor").mockRejectedValue(
      new Error("non-human actor"),
    );
    await expect(dispatch(receipt())).rejects.toThrow("non-human actor");
  });
});
