import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import * as client from "../../src/github/api/client";
import * as contextModule from "../../src/github/context";
import * as fetching from "../../src/github/operations/comments/fetch-droid-comment";
import * as updating from "../../src/github/operations/comments/update-droid-comment";
import * as lifecycle from "../../src/github/operations/review-lifecycle";
import { run } from "../../src/entrypoints/update-comment-link";
import { createMockContext } from "../mockContext";

// A run that is not a review has no lifecycle, and its tracking comment is
// all that says how it ended.
describe("update-comment-link for a run with no review lifecycle", () => {
  let saved: NodeJS.ProcessEnv;
  let updateSpy: ReturnType<typeof spyOn>;
  const updatedBody = (): string => updateSpy.mock.calls[0]?.[1].body;

  beforeEach(() => {
    saved = { ...process.env };
    for (const key of Object.keys(process.env))
      if (
        /^(PREPARE_|DROID_|REVIEW_|MODEL_FALLBACK_NOTE|GITHUB_STEP)/.test(key)
      )
        delete process.env[key];
    Object.assign(process.env, {
      DROID_COMMENT_ID: "55",
      GITHUB_TOKEN: "fixture-token",
      RUNNER_TEMP: "/nonexistent",
    });
    spyOn(contextModule, "parseGitHubContext").mockReturnValue(
      createMockContext({ eventName: "issue_comment", isPR: true }),
    );
    spyOn(client, "createOctokit").mockReturnValue({} as any);
    spyOn(lifecycle, "loadBoundReviewLifecycle").mockResolvedValue(null);
    spyOn(fetching, "fetchDroidComment").mockResolvedValue({
      comment: { body: "Droid is working…" },
      isPRReviewComment: false,
    } as any);
    updateSpy = spyOn(updating, "updateDroidComment").mockResolvedValue(
      {} as any,
    );
    spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    mock.restore();
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it("marks the comment of a failed run with what the failing step said", async () => {
    process.env.DROID_SUCCESS = "false";
    process.env.DROID_ERROR_MESSAGE = "Droid Exec exited with code 1";

    await run();

    expect(updatedBody()).toContain("**Droid encountered an error**");
    expect(updatedBody()).toContain("Droid Exec exited with code 1");
  });

  it("does not mark the comment of a run that succeeded", async () => {
    process.env.DROID_SUCCESS = "true";

    await run();

    expect(updatedBody()).toContain("**Droid finished**");
    expect(updatedBody()).not.toContain("encountered an error");
  });
});
