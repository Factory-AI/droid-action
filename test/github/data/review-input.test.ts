import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareReviewInput } from "../../../src/github/data/review-input";
import * as lifecycle from "../../../src/github/operations/review-lifecycle";
import { normalizeFinding } from "../../../src/core/review/validated/finding";
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
  /** The merge base GitHub names for a comparison, when not its base. */
  let mergeBases: Record<string, string>;

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
              : {
                  merge_base_commit: {
                    sha: mergeBases[basehead] ?? basehead.split("...")[0],
                  },
                },
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
    // What actions/checkout leaves: one branch, which is neither the pull
    // request's head nor the tip of its base.
    checkoutDir = join(dir, "clone");
    await git(
      dir,
      "clone",
      "-q",
      "--single-branch",
      `file://${repo.originDir}`,
      checkoutDir,
    );
    for (const key of [
      "GITHUB_WORKSPACE",
      "RUNNER_TEMP",
      "REVIEW_MODEL",
      "SECURITY_MODEL",
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
    mergeBases = {};
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
    for (const sha of [repo.headSha, repo.baseSha]) {
      await expect(
        git(checkoutDir, "cat-file", "-e", `${sha}^{commit}`),
      ).rejects.toThrow();
    }

    expect(await prepare(runFor(), "the migration")).toEqual({});

    for (const sha of [repo.headSha, repo.baseSha]) {
      await git(checkoutDir, "cat-file", "-e", `${sha}^{commit}`);
    }
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

  it("fetches the head the last review was of, so the worker can review what changed since, and hands on its findings", async () => {
    const known = normalizeFinding({
      id: "f-known",
      severity: "P1",
      title: "Known issue",
      path: "app.ts",
      line: 1,
      body: "Known issue",
    });

    await prepare(
      runFor({
        state: {
          head: repo.priorHeadSha,
          findings: [
            { id: known.id, sev: "P1", state: "open", finding: known },
          ],
        },
        incrementalBaseSha: repo.priorHeadSha,
      }),
    );

    await git(checkoutDir, "cat-file", "-e", `${repo.priorHeadSha}^{commit}`);
    expect((await writtenInput()).prior).toEqual({
      findings: [{ ...known, state: "open" }],
      reviewed: { head: repo.priorHeadSha, incremental: true },
    });
  });

  it("fetches with the token it was given", async () => {
    // A git that notes the request header each command carries, then runs.
    const bin = join(dir, "bin");
    const seen = join(dir, "headers");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$GIT_CONFIG_VALUE_1" >> '${seen}'`,
        `exec '${Bun.which("git")}' "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await prepare(runFor());
    } finally {
      process.env.PATH = path;
    }

    expect(await readFile(seen, "utf8")).toContain(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:test-token").toString("base64")}`,
    );
  });

  it("takes the reviewed head only from a commit ID", async () => {
    // A name the remote resolves, where the stored state should hold an ID.
    await prepare(runFor({ state: { head: "HEAD", findings: [] } }));

    expect(await writtenInput()).not.toHaveProperty("prior");
  });

  it("prepares a security-only review on the security model", async () => {
    process.env.REVIEW_MODEL = "review-model";
    process.env.SECURITY_MODEL = "security-model";

    await prepare(runFor({ securityOnly: true }));

    expect((await writtenInput()).model).toBe("security-model");
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

  it.each([
    ["skips", "is an ancestor of the new one", undefined],
    ["does not skip", "was rebased away", "fork"],
  ] as const)(
    "%s an incremental review of an unchanged tree when the reviewed head %s",
    async (_verb, _name, mergeBase) => {
      const comparison = `${repo.priorHeadSha}...${repo.headSha}`;
      diffs[comparison] = "";
      // GitHub compares from the merge base, so its diff says what changed
      // since the reviewed head only when that head is the merge base.
      if (mergeBase) mergeBases[comparison] = repo.forkSha;

      const prepared = await prepare(
        runFor({
          state: { head: repo.priorHeadSha, findings: [] },
          incrementalBaseSha: repo.priorHeadSha,
        }),
      );

      expect(prepared).toEqual(
        mergeBase
          ? {}
          : {
              skipReason: `No new changes since ${repo.priorHeadSha.slice(0, 7)}`,
            },
      );
    },
  );

  it("compares the whole change when the remote no longer has the reviewed head", async () => {
    const gone = "f".repeat(40);
    diffs[`${repo.baseSha}...${repo.headSha}`] = DIFF;

    const prepared = await prepare(
      runFor({
        state: {
          head: gone,
          findings: [],
          diffHash: createHash("sha256").update(DIFF).digest("hex"),
        },
        incrementalBaseSha: gone,
      }),
    );

    expect(prepared.skipReason).toBe("No new changes since fffffff");
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

  it.each(["head", "base"] as const)(
    "refuses to prepare a review whose %s it could not fetch",
    async (missing) => {
      // The other commit is already there, as after a checkout of the head.
      await git(checkoutDir, "fetch", "-q", "origin", "refs/pull/123/head");

      await expect(
        prepare(runFor({ [missing]: "e".repeat(40) })),
      ).rejects.toThrow("Droid could not fetch the pull request's commits.");
      expect(await exists(inputPath())).toBe(false);
    },
  );
});
