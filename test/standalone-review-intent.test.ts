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
import * as reviewInput from "../src/github/data/review-input";
import * as lifecycle from "../src/github/operations/review-lifecycle";
import * as config from "../src/prepare/review-config";
import * as runtime from "../src/prepare/review-runtime";
import { run } from "../src/entrypoints/generate-review-prompt";
import { resolveReviewUxConfig } from "../src/core/review/config";
import { createMockContext } from "./mockContext";

let saved: NodeJS.ProcessEnv;
let context: ReturnType<typeof createMockContext>;
let prepareSpy: ReturnType<typeof spyOn>;
let inputSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  saved = { ...process.env };
  for (const key of Object.keys(process.env))
    if (
      /^(REVIEW_|SECURITY_|DROID_|GITHUB_ENV|WORKFLOW_GITHUB_TOKEN)/.test(key)
    )
      delete process.env[key];
  Object.assign(process.env, {
    GITHUB_TOKEN: "fixture-secret-token-1234",
    DROID_COMMENT_ID: "55",
  });
  context = createMockContext({
    eventName: "issue_comment",
    isPR: true,
    payload: {
      comment: { body: "@droid review", created_at: "2026-10-30T00:00:00Z" },
    } as any,
    inputs: { reviewConfig: resolveReviewUxConfig() },
  });
  spyOn(core, "setOutput").mockImplementation(() => {});
  spyOn(core, "exportVariable").mockImplementation(() => {});
  spyOn(core, "setFailed").mockImplementation((message) => {
    throw new Error(String(message));
  });
  spyOn(client, "createOctokit").mockReturnValue({} as any);
  spyOn(contextModule, "parseGitHubContext").mockImplementation(() => context);
  spyOn(pr, "fetchPRBranchData").mockResolvedValue({
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: "a".repeat(40),
    isFork: false,
    title: "Fixture",
    body: "",
  });
  inputSpy = spyOn(reviewInput, "prepareReviewInput").mockResolvedValue({});
  prepareSpy = spyOn(lifecycle, "prepareReviewLifecycle").mockImplementation(
    async (options) => ({
      commentId: 55,
      state: { head: "a".repeat(40), findings: [] },
      skipReason: options.skipReason ?? undefined,
      run: {} as any,
    }),
  );
  spyOn(lifecycle, "readReviewLifecycle").mockResolvedValue(null);
  spyOn(config, "initializeReviewConfig").mockResolvedValue();
  spyOn(runtime, "freezeReviewRuntime").mockResolvedValue({});
});
afterEach(() => {
  mock.restore();
  for (const key of Object.keys(process.env))
    if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
function bodyRequest(body: string, automatic: boolean, eventAction = "opened") {
  context = createMockContext({
    eventName: "pull_request",
    eventAction,
    isPR: true,
    payload: {
      pull_request: { body, draft: false },
      changes: { body: { from: "Original description" } },
    } as any,
    inputs: {
      automaticReview: automatic,
      reviewConfig: resolveReviewUxConfig(),
    },
  });
}
describe("standalone adapter preserves submitted review focus without granting automatic full overrides", () => {
  it("hands the focus of a submitted review body to the review's input", async () => {
    context.eventName = "pull_request_review";
    context.eventAction = "submitted";
    context.payload = {
      review: { body: "@droid review focus on authentication" },
    } as any;
    await run();
    expect(inputSpy.mock.calls[0]?.[0].focus).toBe("focus on authentication");
  });
  it("hands no focus from a request the event did not make", async () => {
    bodyRequest("@droid review focus on authentication", true);
    await run();
    expect(inputSpy).toHaveBeenCalledTimes(1);
    expect(inputSpy.mock.calls[0]?.[0].focus).toBeUndefined();
  });
  it("does not let an automatic PR-body --full override incremental memory", async () => {
    bodyRequest("@droid review --full", true);
    await run();
    expect(Boolean(prepareSpy.mock.calls[0]?.[0].full)).toBe(false);
  });
  it("keeps explicit manual comment --full", async () => {
    (context.payload as any).comment.body = "@droid review --full";
    await run();
    expect(prepareSpy.mock.calls[0]?.[0].full).toBe(true);
  });
  it("does not grant --full from a persistent body on a title-only edit", async () => {
    bodyRequest("@droid review --full", false, "edited");
    (context.payload as any).changes = { title: { from: "Old title" } };
    await run();
    expect(Boolean(prepareSpy.mock.calls[0]?.[0].full)).toBe(false);
  });
  it("recognizes a genuinely added body --full even when the command name is unchanged", async () => {
    bodyRequest("@droid review --full", false, "edited");
    (context.payload as any).changes.body.from = "@droid review";
    await run();
    expect(prepareSpy.mock.calls[0]?.[0].full).toBe(true);
  });
  it("preserves ordinary non-full manual code review", async () => {
    await run();
    expect(Boolean(prepareSpy.mock.calls[0]?.[0].full)).toBe(false);
  });
  it("preserves the earlier manual security full override", async () => {
    (context.payload as any).comment.body = "@droid security";
    process.env.REVIEW_TYPE = "security";
    await run();
    expect(prepareSpy.mock.calls[0]?.[0].full).toBe(true);
  });
});
