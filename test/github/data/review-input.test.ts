import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareReviewInput } from "../../../src/github/data/review-input";
import * as lifecycle from "../../../src/github/operations/review-lifecycle";
import { checkoutWithPullRequest, git } from "../../core/worker/fixtures";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const PULL_REQUEST = {
  baseRefName: "release",
  headRefName: "feature",
  isFork: false,
  title: "Add the feature",
  body: "",
};
const DIFF = "diff --git a/feature.ts b/feature.ts\n+export const f = 1;\n";

describe("prepareReviewInput", () => {
  const saved = new Map<string, string | undefined>();
  let dir = "";
  let repo: Awaited<ReturnType<typeof checkoutWithPullRequest>>;
  let checkoutDir = "";
  let finishSpy: ReturnType<typeof spyOn>;
  let saveSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  /** The diff GitHub answers each `base...head` comparison with. */
  let diffs: Record<string, string>;

  const inputPath = () =>
    join(dir, "runner", "droid-prompts", "review_input.json");
  const writtenInput = async () =>
    JSON.parse(await readFile(inputPath(), "utf8"));

  const octokit = {
    rest: {
      paginate: async (
        list: (parameters: unknown) => Promise<{ data: unknown[] }>,
        parameters: unknown,
      ) => (await list(parameters)).data,
      issues: {
        listComments: async () => ({ data: [{ id: 1, body: "A comment" }] }),
      },
      pulls: {
        listReviewComments: async () => ({ data: [{ id: 2, path: "app.ts" }] }),
      },
      repos: {
        compareCommitsWithBasehead: async ({
          basehead,
          mediaType,
        }: {
          basehead: string;
          mediaType?: unknown;
        }) => {
          if (!(basehead in diffs)) throw new Error("Not Found");
          return {
            data: mediaType
              ? diffs[basehead]
              : { merge_base_commit: { sha: basehead.split("...")[0] } },
          };
        },
      },
    },
  } as any;

  function runFor(
    overrides: Partial<lifecycle.ReviewLifecycleRun> = {},
  ): lifecycle.ReviewLifecycleRun {
    return {
      owner: "acme",
      repo: "app",
      prNumber: 123,
      head: repo.headSha,
      base: repo.baseSha,
      runId: "77",
      runAttempt: "2",
      commentId: 55,
      state: { head: "", findings: [] },
      completed: false,
      startedAt: "2026-01-01T00:00:00Z",
      automatic: true,
      securityOnly: false,
      ...overrides,
    } as lifecycle.ReviewLifecycleRun;
  }

  const prepare = (run: lifecycle.ReviewLifecycleRun, focus?: string) =>
    prepareReviewInput({
      octokit,
      githubToken: "test-token",
      run,
      pullRequest: PULL_REQUEST,
      focus,
    });

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "review-input-test-")));
    repo = await checkoutWithPullRequest(dir);
    // A clone takes the branches, and a pull request's head is not one.
    checkoutDir = join(dir, "clone");
    await git(dir, "clone", "-q", `file://${repo.originDir}`, checkoutDir);
    for (const key of [
      "GITHUB_WORKSPACE",
      "RUNNER_TEMP",
      "REVIEW_MODEL",
      "REASONING_EFFORT",
      "SECURITY_REVIEW_ENABLED",
      "INCLUDE_SUGGESTIONS",
    ]) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.GITHUB_WORKSPACE = checkoutDir;
    process.env.RUNNER_TEMP = join(dir, "runner");
    diffs = {};
    finishSpy = spyOn(lifecycle, "finishReviewLifecycle").mockResolvedValue();
    saveSpy = spyOn(lifecycle, "saveReviewLifecycle").mockResolvedValue();
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    finishSpy.mockRestore();
    saveSpy.mockRestore();
    warnSpy.mockRestore();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("fetches the pull request's commits and leaves the worker's input, readable only by the job", async () => {
    await expect(
      git(checkoutDir, "cat-file", "-e", `${repo.headSha}^{commit}`),
    ).rejects.toThrow();

    expect(await prepare(runFor(), "the migration")).toEqual({});

    await git(checkoutDir, "cat-file", "-e", `${repo.headSha}^{commit}`);
    expect(await writtenInput()).toMatchObject({
      repo: "acme/app",
      prNumber: 123,
      runId: "77",
      runAttempt: "2",
      base: repo.baseSha,
      head: repo.headSha,
      baseRef: "release",
      headRef: "feature",
      fork: false,
      focus: "the migration",
      comments: JSON.stringify(
        {
          issueComments: [{ id: 1, body: "A comment" }],
          reviewComments: [{ id: 2, path: "app.ts" }],
        },
        null,
        2,
      ),
    });
    expect(await writtenInput()).not.toHaveProperty("prior");
    expect((await stat(inputPath())).mode & 0o777).toBe(0o600);
    expect(finishSpy).not.toHaveBeenCalled();
  });

  it("fetches the head the last review was of, so the worker can review what changed since", async () => {
    await prepare(
      runFor({
        state: { head: repo.priorHeadSha, findings: [] },
        incrementalBaseSha: repo.priorHeadSha,
      }),
    );

    await git(checkoutDir, "cat-file", "-e", `${repo.priorHeadSha}^{commit}`);
    expect((await writtenInput()).prior).toEqual({
      findings: [],
      reviewed: { head: repo.priorHeadSha, incremental: true },
    });
  });

  it("reviews the whole change when the remote no longer has the reviewed head", async () => {
    const gone = "f".repeat(40);

    await prepare(
      runFor({
        state: { head: gone, findings: [] },
        incrementalBaseSha: gone,
      }),
    );

    expect((await writtenInput()).prior).toEqual({ findings: [] });
  });

  it("ends the review as skipped, leaving no input, when GitHub's diff is the one last reviewed", async () => {
    diffs[`${repo.baseSha}...${repo.headSha}`] = DIFF;
    const run = runFor({
      state: {
        head: repo.priorHeadSha,
        findings: [],
        diffHash: createHash("sha256").update(DIFF).digest("hex"),
      },
      previousBody: "The last summary",
    });

    const prepared = await prepare(run);

    expect(prepared.skipReason).toBe(
      `No new changes since ${repo.priorHeadSha.slice(0, 7)}`,
    );
    expect(await exists(inputPath())).toBe(false);
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ skipReason: prepared.skipReason }),
    );
    expect(finishSpy.mock.calls[0]?.[0]).toMatchObject({
      run,
      input: {
        state: "skipped",
        skipReason: prepared.skipReason,
        head: repo.headSha,
        previousHead: repo.priorHeadSha,
        previousBody: "The last summary",
      },
    });
  });

  it.each([
    ["the diff changed", () => "another diff", false],
    ["a person asked for the whole review", () => DIFF, true],
  ])("does not skip when %s", async (_name, hashed, full) => {
    diffs[`${repo.baseSha}...${repo.headSha}`] = DIFF;

    const prepared = await prepare(
      runFor({
        full,
        state: {
          head: repo.priorHeadSha,
          findings: [],
          diffHash: createHash("sha256").update(hashed()).digest("hex"),
        },
      }),
    );

    expect(prepared).toEqual({});
    expect(await exists(inputPath())).toBe(true);
  });

  it("does not skip a review whose diff GitHub would not give", async () => {
    const prepared = await prepare(
      runFor({
        state: { head: repo.priorHeadSha, findings: [], diffHash: "x" },
      }),
    );

    expect(prepared).toEqual({});
    expect(await exists(inputPath())).toBe(true);
  });

  it("refuses to prepare a review of commits it could not fetch", async () => {
    await expect(prepare(runFor({ head: "e".repeat(40) }))).rejects.toThrow(
      "Droid could not fetch the pull request's commits.",
    );
    expect(await exists(inputPath())).toBe(false);
  });
});
