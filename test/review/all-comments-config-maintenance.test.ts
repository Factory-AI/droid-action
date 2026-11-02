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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseReviewConfigYaml,
  resolveReviewUxConfig,
  reviewConfigEnvironment,
  reviewConfigFromEnvironment,
} from "../../src/core/review/config";
import { reviewPromptSettingsFromEnvironment } from "../../src/core/review/prompts/settings";
import type { ReviewPromptSettings } from "../../src/core/review/prompts/types";
import { record } from "../../src/core/review/validated/finding";
import {
  enrichReviewSummary,
  type ReviewMetadataInput,
} from "../../src/core/review/validated/metadata";
import { parseValidatedReview } from "../../src/core/review/validated/parse";
import { parseReviewPostResults } from "../../src/core/review/tracking/results";
import { initializeReviewConfig } from "../../src/prepare/review-config";
import { GitlabClient } from "../../src/gitlab/api/client";
import { run as prepareGitlabReview } from "../../src/entrypoints/gitlab-prepare";
import { run as prepareGitlabValidator } from "../../src/entrypoints/gitlab-prepare-validator";
import * as droidSettings from "../../base-action/src/setup-droid-settings";
import { resolveReviewConfig } from "../../src/utils/review-depth";
import { createMockContext } from "../mockContext";

let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of Object.keys(
    reviewConfigEnvironment(resolveReviewUxConfig()),
  ))
    delete process.env[key];
});
afterEach(() => {
  mock.restore();
  for (const key of Object.keys(process.env))
    if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

describe("all-comments lossless configuration transport", () => {
  const ignorePaths = ["src/{client,server}/**", "docs/release,notes.md"];
  it("exports lossless base lists from real GitLab preparation without a model or network", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qa75-gitlab-prepare-"));
    const user = { id: 1, username: "droid" };
    const diffRefs = {
      head_sha: "a".repeat(40),
      base_sha: "b".repeat(40),
      start_sha: "b".repeat(40),
    };
    const mr = {
      id: 70,
      iid: 7,
      project_id: 42,
      title: "Preserve configuration lists",
      description: "Keep base-owned review configuration intact.",
      state: "opened",
      author: user,
      source_branch: "feature",
      target_branch: "main",
      source_project_id: 42,
      target_project_id: 42,
      draft: false,
      work_in_progress: false,
      diff_refs: diffRefs,
      web_url: "https://gitlab.invalid/group/repo/-/merge_requests/7",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    try {
      Object.assign(process.env, {
        HOME: directory,
        CI_PROJECT_ID: "42",
        CI_PROJECT_PATH: "group/repo",
        CI_MERGE_REQUEST_IID: "7",
        CI_COMMIT_SHA: diffRefs.head_sha,
        CI_PIPELINE_SOURCE: "merge_request_event",
        GITLAB_TOKEN: "test-token",
        DROID_STATE_FILE: join(directory, "state.json"),
        DROID_PROMPT_FILE: join(directory, "prompt.txt"),
      });
      delete process.env.DROID_TRIGGER_NOTE_ID;
      delete process.env.OVERRIDE_GITLAB_TOKEN;
      spyOn(droidSettings, "setupDroidSettings").mockResolvedValue(undefined);
      spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async () => {
            throw new Error("Unexpected network request");
          },
          { preconnect() {} },
        ),
      );
      spyOn(GitlabClient.prototype, "getCurrentUser").mockResolvedValue(user);
      spyOn(GitlabClient.prototype, "listNotes").mockResolvedValue([]);
      spyOn(GitlabClient.prototype, "getMr").mockResolvedValue(mr);
      spyOn(GitlabClient.prototype, "getMrChanges").mockResolvedValue({
        changes: [],
        diff_refs: diffRefs,
      });
      spyOn(GitlabClient.prototype, "getBranch").mockResolvedValue({
        name: "main",
        protected: false,
        can_push: true,
        commit: { id: diffRefs.base_sha },
      });
      spyOn(GitlabClient.prototype, "getRepositoryFile").mockResolvedValue(
        [
          "automatic_review: false",
          "automatic_security_review: false",
          "review_check_run: false",
          "review_reactions: false",
          "review_auto_triggers: []",
          "review_pre_merge_checks: []",
          `review_ignore_paths: ${JSON.stringify(ignorePaths)}`,
        ].join("\n"),
      );
      spyOn(GitlabClient.prototype, "getTree").mockResolvedValue([
        { path: ".factory/review.yaml", mode: "100644", type: "blob" },
      ]);
      spyOn(GitlabClient.prototype, "createNote").mockResolvedValue({
        id: 1,
        type: null,
        body: "",
        author: user,
        created_at: mr.created_at,
        updated_at: mr.updated_at,
        system: false,
        noteable_id: mr.id,
        noteable_iid: mr.iid,
        noteable_type: "MergeRequest",
        resolvable: false,
      });
      await prepareGitlabReview();
      expect(reviewPromptSettingsFromEnvironment().ignorePaths).toEqual(
        ignorePaths,
      );
      expect(reviewConfigFromEnvironment().review_auto_triggers).toEqual([]);
      expect(reviewConfigFromEnvironment().review_reactions).toBe(false);
      expect(reviewConfigFromEnvironment().review_max_auto_runs).toBe(0);
      expect(
        JSON.parse(process.env.REVIEW_CONFIG_JSON!).review_ignore_paths,
      ).toEqual(ignorePaths);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves comma-containing lists, explicit empty lists, false and zero", () => {
    const config = resolveReviewUxConfig({
      fileConfig: {
        review_ignore_paths: ignorePaths,
        review_pre_merge_checks: [],
        review_auto_triggers: [],
        review_reactions: false,
        review_max_auto_runs: 0,
      },
    });
    const env = reviewConfigEnvironment(config);
    expect(reviewConfigFromEnvironment(env)).toEqual(config);
    expect(reviewPromptSettingsFromEnvironment(env).ignorePaths).toEqual(
      ignorePaths,
    );
    expect(JSON.parse(env.REVIEW_CONFIG_JSON!)).toEqual(config);
    expect(
      reviewConfigFromEnvironment({ ...env, REVIEW_IGNORE_PATHS: "model/**" }),
    ).toEqual(config);
  });

  it("passes the exact list through real GitLab validator preparation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qa75-gitlab-config-"));
    try {
      const config = resolveReviewUxConfig({
        fileConfig: {
          review_ignore_paths: ignorePaths,
          review_pre_merge_checks: [],
        },
      });
      const candidatesPath = join(directory, "candidates.json");
      const promptPath = join(directory, "prompt.md");
      process.env.DROID_STATE_FILE = join(directory, "state.json");
      await writeFile(candidatesPath, JSON.stringify({ comments: [] }));
      await writeFile(
        process.env.DROID_STATE_FILE,
        JSON.stringify({
          shouldRunReview: true,
          projectPath: "group/project",
          mrIid: 7,
          promptPath,
          candidatesPath,
          validatedPath: join(directory, "validated.json"),
          diffPath: join(directory, "mr.diff"),
          commentsPath: join(directory, "comments.json"),
          descriptionPath: join(directory, "description.txt"),
          headSha: "a".repeat(40),
          includeSuggestions: true,
          securityReviewEnabled: false,
          reviewConfig: config,
        }),
      );
      await prepareGitlabValidator();
      const prompt = await readFile(promptPath, "utf8");
      expect(prompt).toContain(
        `"ignorePaths": ${JSON.stringify(ignorePaths, null, 2).replace(/\n/g, "\n  ")}`,
      );
      expect(prompt).toContain('"preMergeChecks": []');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("classifies every schema-owned boolean and list input without losing false or []", () => {
    for (const [key, value] of Object.entries(resolveReviewUxConfig())) {
      if (typeof value === "boolean") {
        for (const raw of ["true", "false"]) {
          expect(
            resolveReviewUxConfig({ inputs: { [key]: raw } })[
              key as keyof ReturnType<typeof resolveReviewUxConfig>
            ],
          ).toBe(raw === "true");
        }
        expect(() =>
          resolveReviewUxConfig({ inputs: { [key]: "yes" } }),
        ).toThrow();
      } else if (Array.isArray(value)) {
        for (const raw of ["[]", "off"]) {
          expect(
            resolveReviewUxConfig({ inputs: { [key]: raw } })[
              key as keyof ReturnType<typeof resolveReviewUxConfig>
            ],
          ).toEqual([]);
        }
      }
    }
  });

  it.each(["SHALLOW", " ShAlLoW "])(
    "normalizes %s consistently for input, environment and model presets",
    (depth) => {
      expect(
        resolveReviewUxConfig({ inputs: { review_depth: depth } }).review_depth,
      ).toBe("shallow");
      expect(
        reviewConfigFromEnvironment({ REVIEW_DEPTH: depth }).review_depth,
      ).toBe("shallow");
      expect(resolveReviewConfig({ reviewDepth: depth })).toEqual(
        resolveReviewConfig({ reviewDepth: "shallow" }),
      );
      expect(() =>
        parseReviewConfigYaml(`review_depth: ${depth.trim()}`),
      ).toThrow();
    },
  );

  it("keeps strict base configuration and safe invalid-depth fallback", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    expect(
      resolveReviewUxConfig({ inputs: { review_depth: "not-a-depth" } })
        .review_depth,
    ).toBe("deep");
    expect(resolveReviewConfig({ reviewDepth: "not-a-depth" })).toEqual(
      resolveReviewConfig(),
    );
    expect(warning).toHaveBeenCalledWith(
      "Unknown review_depth; falling back to deep.",
    );
    expect(() => parseReviewConfigYaml("review_depth: SHALLOW")).toThrow();
  });
});

describe("all-comments pinned regular GitHub configuration", () => {
  function fixture(
    tree: unknown = {
      truncated: false,
      tree: [{ path: "review.yaml", type: "blob", mode: "100644" }],
    },
  ) {
    spyOn(core, "exportVariable").mockImplementation(() => {});
    spyOn(core, "setOutput").mockImplementation(() => {});
    const getContent = mock(async () => ({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from("review_depth: shallow").toString("base64"),
      },
    }));
    const getTree = mock(async ({ tree_sha }: { tree_sha: string }) => ({
      data:
        tree_sha === "a".repeat(40)
          ? {
              truncated: false,
              tree: [
                {
                  path: ".factory",
                  type: "tree",
                  mode: "040000",
                  sha: "c".repeat(40),
                },
              ],
            }
          : tree,
    }));
    const get = mock(async () => ({
      data: { base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) } },
    }));
    const context = createMockContext({
      isPR: true,
      entityNumber: 7,
      inputs: {},
    });
    return {
      context,
      getContent,
      getTree,
      client: {
        rest: { pulls: { get }, repos: { getContent }, git: { getTree } },
      },
    };
  }
  it.each(["100644", "100755"])(
    "accepts regular Git object mode %s pinned to base, never head",
    async (mode) => {
      const f = fixture({
        truncated: false,
        tree: [{ path: "review.yaml", type: "blob", mode }],
      });
      await initializeReviewConfig(f.context, f.client);
      expect(f.context.inputs.reviewConfig?.review_depth).toBe("shallow");
      expect(f.getTree).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        tree_sha: "a".repeat(40),
      });
      expect(f.getTree).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        tree_sha: "c".repeat(40),
      });
      expect(f.getContent).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { type: "blob", mode: "120000" },
    { type: "commit", mode: "160000" },
    { type: "tree", mode: "040000" },
  ])(
    "rejects dereferenced type=file when immutable Git mode is $mode",
    async (entry) => {
      const f = fixture({
        truncated: false,
        tree: [{ path: "review.yaml", ...entry }],
      });
      await expect(initializeReviewConfig(f.context, f.client)).rejects.toThrow(
        "regular UTF-8",
      );
      expect(f.getContent).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    {
      truncated: true,
      tree: [{ path: "review.yaml", type: "blob", mode: "100644" }],
    },
    { truncated: false, tree: [] },
    { truncated: false, tree: null },
  ])("fails closed when Git mode cannot be established", async (tree) => {
    const f = fixture(tree);
    await expect(initializeReviewConfig(f.context, f.client)).rejects.toThrow();
    expect(f.context.inputs.reviewConfig).toBeUndefined();
  });
  it.each([
    { type: "blob", mode: "120000", sha: "c".repeat(40) },
    { type: "commit", mode: "160000", sha: "c".repeat(40) },
    { type: "tree", mode: "040000", sha: "invalid" },
  ])("rejects unsafe or unverifiable parent directories", async (entry) => {
    const f = fixture();
    f.getTree.mockResolvedValueOnce({
      data: { truncated: false, tree: [{ path: ".factory", ...entry }] },
    });
    await expect(initializeReviewConfig(f.context, f.client)).rejects.toThrow(
      "regular UTF-8",
    );
    expect(f.getTree).toHaveBeenCalledTimes(1);
  });
  it("does not treat a tree API 404 as absent configuration", async () => {
    const f = fixture();
    f.getTree.mockRejectedValue(
      Object.assign(new Error("unavailable Git tree"), { status: 404 }),
    );
    await expect(initializeReviewConfig(f.context, f.client)).rejects.toThrow(
      "unavailable Git tree",
    );
    expect(f.getTree).toHaveBeenCalledTimes(1);
  });
  it("retains optional missing config and size limits without any head fallback", async () => {
    const f = fixture();
    f.getContent.mockRejectedValueOnce(
      Object.assign(new Error("missing"), { status: 404 }),
    );
    await initializeReviewConfig(f.context, f.client);
    expect(f.context.inputs.reviewConfig).toEqual(resolveReviewUxConfig());
    expect(f.getTree).not.toHaveBeenCalled();
    f.getContent.mockResolvedValueOnce({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(" ".repeat(65537)).toString("base64"),
      },
    });
    await expect(initializeReviewConfig(f.context, f.client)).rejects.toThrow(
      "64 KiB",
    );
  });
});

describe("all-comments parser and type maintenance", () => {
  it("shares the same non-array record semantics without changing reference identity", () => {
    for (const value of [null, undefined, false, 0, "object", []]) {
      expect(record(value)).toBeNull();
      expect(() =>
        parseValidatedReview(JSON.stringify(value) ?? "null"),
      ).toThrow();
      expect(() =>
        parseReviewPostResults(JSON.stringify(value) ?? "null"),
      ).toThrow();
    }
    const object = { results: [] };
    expect(record(object)).toBe(object);
    expect(parseValidatedReview(JSON.stringify(object)).fixedFindings).toEqual(
      [],
    );
    const parsed = parseReviewConfigYaml("depth: shallow");
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed).toEqual({ review_depth: "shallow" });
    expect(() =>
      parseReviewConfigYaml("__proto__: {review_depth: shallow}"),
    ).toThrow();
  });
  it("retains mandatory fixed evidence as the only resolution authority", () => {
    const parsed = parseValidatedReview(
      JSON.stringify({
        results: [
          {
            status: "fixed",
            id: "good",
            evidence: "Verified corrected execution",
          },
          { status: "fixed", id: "no-evidence" },
        ],
      }),
    );
    expect(parsed.fixedFindings).toEqual([
      { id: "good", evidence: "Verified corrected execution" },
    ]);
    expect(parsed.skipped).toHaveLength(1);
    expect(parsed).not.toHaveProperty("fixedFindingIds");
  });
  it("uses config-owned pre-merge types and does not trust disabled model checks", () => {
    const checks = resolveReviewUxConfig({
      inputs: { review_pre_merge_checks: "title,description,linked_issue" },
    }).review_pre_merge_checks;
    const promptChecks: ReviewPromptSettings["preMergeChecks"] = checks;
    const metadataChecks: ReviewMetadataInput["preMergeChecks"] = promptChecks;
    const input = {
      changedPaths: [],
      title: "Fix bounded retries",
      description: "Fixes #7 with a regression test for exhausted retries.",
      preMergeChecks: metadataChecks,
    };
    expect(
      enrichReviewSummary({}, input).preMergeChecks?.map(
        (check) => check.passed,
      ),
    ).toEqual([true, true, true]);
    expect(
      enrichReviewSummary(
        { preMergeChecks: [{ name: "invented", passed: true }] },
        { ...input, preMergeChecks: [] },
      ).preMergeChecks,
    ).toBeUndefined();
  });
});
