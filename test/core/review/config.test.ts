import { describe, expect, it, mock, spyOn } from "bun:test";
import {
  automaticReviewSkipReason,
  parseReviewConfigYaml,
  resolveReviewUxConfig,
  reviewConfigEnvironment,
  reviewConfigFromEnvironment,
  shouldIgnoreReviewPath,
} from "../../../src/core/review/config";
import { loadReviewUxConfigFromBase } from "../../../src/github/data/review-config";
import { resolveReviewConfig } from "../../../src/utils/review-depth";

const git = {
  getTree: async ({ tree_sha }: { tree_sha: string }) => ({
    data: {
      truncated: false,
      tree:
        tree_sha === "c".repeat(40)
          ? [{ path: "review.yaml", type: "blob", mode: "100644" }]
          : [
              {
                path: ".factory",
                type: "tree",
                mode: "040000",
                sha: "c".repeat(40),
              },
            ],
    },
  }),
};

describe("trusted base review configuration", () => {
  it("keeps documented effective defaults without action inputs", () => {
    const config = resolveReviewUxConfig();
    expect(config).toMatchObject({
      review_depth: "deep",
      review_summary: "comment",
      review_badges: "text",
      review_reactions: true,
      review_check_run: true,
      fail_on_severity: "",
      review_incremental: true,
      review_auto_resolve: true,
      review_max_auto_runs: 0,
      show_dropped_findings: false,
      include_agent_prompts: true,
      fix_mode: "commit",
      automatic_review: false,
      automatic_security_review: false,
      security_block_on_critical: true,
      security_block_on_high: false,
    });
  });

  it("applies defaults, base config, then explicit inputs including false and zero", () => {
    const config = resolveReviewUxConfig({
      fileConfig: parseReviewConfigYaml(
        [
          "depth: shallow",
          "badges: emoji",
          "incremental: false",
          "max_auto_runs: 5",
          "review_reactions: true",
          "fail_on_severity: P1",
          "auto_review:",
          "  enabled: true",
          "  drafts: true",
        ].join("\n"),
      ),
      inputs: {
        review_depth: "",
        review_badges: "text",
        review_reactions: "false",
        review_max_auto_runs: "0",
        fail_on_severity: "off",
        automatic_review: "false",
      },
    });
    expect(config.review_depth).toBe("shallow");
    expect(config.review_badges).toBe("text");
    expect(config.review_incremental).toBe(false);
    expect(config.review_max_auto_runs).toBe(0);
    expect(config.review_reactions).toBe(false);
    expect(config.automatic_review).toBe(false);
    expect(config.automatic_security_review).toBe(false);
    expect(config.fail_on_severity).toBe("");
    expect(config.review_drafts).toBe(true);
  });

  it("does not erase explicit security opt-out when automatic code review is enabled", () => {
    expect(
      resolveReviewUxConfig({
        inputs: {
          automatic_review: "true",
          automatic_security_review: "false",
        },
      }).automatic_security_review,
    ).toBe(false);
    expect(
      resolveReviewUxConfig({ inputs: { automatic_review: "true" } })
        .automatic_security_review,
    ).toBe(true);
  });

  it("roundtrips every effective setting through step environment", () => {
    const config = resolveReviewUxConfig({
      inputs: {
        review_ignore_paths: "[]",
        review_pre_merge_checks: "title,description,linked_issue",
        review_max_auto_runs: "0",
      },
    });
    expect(
      reviewConfigFromEnvironment(reviewConfigEnvironment(config)),
    ).toEqual(config);
  });

  it("uses immutable configuration instead of model-mutated flat environment", () => {
    const config = resolveReviewUxConfig({
      inputs: {
        fail_on_severity: "P1",
        review_reactions: "false",
        security_block_on_high: "true",
      },
    });
    expect(
      reviewConfigFromEnvironment({
        REVIEW_CONFIG_JSON: JSON.stringify(config),
        FAIL_ON_SEVERITY: "off",
        REVIEW_REACTIONS: "true",
        SECURITY_BLOCK_ON_HIGH: "false",
      }),
    ).toEqual(config);
    expect(() =>
      reviewConfigFromEnvironment({ REVIEW_CONFIG_JSON: "invalid" }),
    ).toThrow("immutable");
    expect(() =>
      reviewConfigFromEnvironment({ REVIEW_CONFIG_JSON: "[]" }),
    ).toThrow("immutable");
  });

  it.each([
    "depth: fk-example-secret",
    "fk-example-secret: true",
    "__proto__: {review_depth: shallow}",
  ])("rejects invalid config without leaking keys or values: %s", (raw) => {
    try {
      parseReviewConfigYaml(raw);
      throw Error("Expected invalid config");
    } catch (error) {
      expect(String(error)).not.toContain("fk-example-secret");
      expect(String(error)).toContain("Invalid .factory/review.yaml");
    }
  });

  it.each([
    "depth: unsafe",
    "review_max_auto_runs: -1",
    "review_incremental: nope",
    "depth: deep\nreview_depth: shallow",
    "unknown_setting: true",
    "auto_review:\n  enabled: true\n  unknown: true",
    "auto_review:\n  enabled: true\nautomatic_review: false",
    "review_depth: deep\nreview_depth: shallow",
  ])("rejects invalid or ambiguous base policy: %s", (raw) => {
    expect(() => parseReviewConfigYaml(raw)).toThrow();
  });

  it("does not expose YAML parser values in a malformed configuration error", () => {
    expect(() => parseReviewConfigYaml("value: [fk-example-secret")).toThrow(
      "configuration is not valid YAML",
    );
    try {
      parseReviewConfigYaml("value: [fk-example-secret");
    } catch (error) {
      expect(String(error)).not.toContain("fk-example-secret");
    }
  });

  it("bounds YAML size and rejects non-mapping documents", () => {
    expect(() => parseReviewConfigYaml(" ".repeat(65537))).toThrow("64 KiB");
    expect(() => parseReviewConfigYaml("- depth\n- shallow")).toThrow(
      "mapping",
    );
  });

  it("uses generated/lock-file defaults and explicit path overrides", () => {
    const config = resolveReviewUxConfig();
    for (const file of [
      "bun.lock",
      "Cargo.lock",
      "nested/package-lock.json",
      "pnpm-lock.yaml",
      "dist/index.js",
      "pkg/generated/client.ts",
      "src/types.generated.ts",
    ]) {
      expect(shouldIgnoreReviewPath(file, config)).toBe(true);
    }
    expect(shouldIgnoreReviewPath("src/index.ts", config)).toBe(false);
    const overridden = resolveReviewUxConfig({
      inputs: { review_ignore_paths: "docs/**,vendor/**" },
    });
    expect(shouldIgnoreReviewPath("docs/setup.md", overridden)).toBe(true);
    expect(shouldIgnoreReviewPath("bun.lock", overridden)).toBe(false);
  });

  it("skips configured automatic events and drafts but not manual commands", () => {
    const config = resolveReviewUxConfig();
    expect(
      automaticReviewSkipReason({ config, draft: true, manual: false }),
    ).toContain("draft");
    expect(
      automaticReviewSkipReason({ config, draft: true, manual: true }),
    ).toBeNull();
    expect(
      automaticReviewSkipReason({
        config,
        draft: false,
        manual: false,
        eventAction: "edited",
      }),
    ).toContain("disabled");
    expect(
      automaticReviewSkipReason({
        config,
        draft: false,
        manual: false,
        eventAction: "synchronize",
      }),
    ).toBeNull();
  });

  it("falls back to deep for unknown action depth and warns without echoing input", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        resolveReviewUxConfig({ inputs: { review_depth: "unknown" } })
          .review_depth,
      ).toBe("deep");
      expect(resolveReviewConfig({ reviewDepth: "unknown" })).toEqual(
        resolveReviewConfig({ reviewDepth: "deep" }),
      );
      expect(warning).toHaveBeenCalledWith(
        "Unknown review_depth; falling back to deep.",
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("pins the only file read to a freshly fetched immutable base SHA", async () => {
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const get = mock(async () => ({
      data: { base: { sha: base }, head: { sha: head } },
    }));
    const getContent = mock(
      async (_params: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }) => ({
        data: {
          type: "file",
          encoding: "base64",
          content: Buffer.from("depth: shallow\nfix_mode: off").toString(
            "base64",
          ),
        },
      }),
    );
    const config = await loadReviewUxConfigFromBase({
      client: { rest: { pulls: { get }, repos: { getContent }, git } },
      owner: "owner",
      repo: "repo",
      prNumber: 7,
      inputs: { review_badges: "emoji" },
    });
    expect(config.review_depth).toBe("shallow");
    expect(config.fix_mode).toBe("off");
    expect(config.review_badges).toBe("emoji");
    expect(getContent).toHaveBeenCalledTimes(1);
    expect(getContent.mock.calls[0]?.[0]).toEqual({
      owner: "owner",
      repo: "repo",
      path: ".factory/review.yaml",
      ref: base,
    });
  });

  it("treats an absent base config as optional, without falling back to head", async () => {
    const getContent = mock(async () => {
      throw Object.assign(new Error("missing"), { status: 404 });
    });
    const config = await loadReviewUxConfigFromBase({
      client: {
        rest: {
          pulls: {
            get: async () => ({ data: { base: { sha: "a".repeat(40) } } }),
          },
          repos: { getContent },
          git,
        },
      },
      owner: "owner",
      repo: "repo",
      prNumber: 7,
    });
    expect(config).toEqual(resolveReviewUxConfig());
    expect(getContent).toHaveBeenCalledTimes(1);
  });

  it("refuses unsafe ref fallback and symlink config", async () => {
    const getContent = mock(async () => ({
      data: { type: "symlink", target: "../../outside" },
    }));
    const client = {
      rest: {
        pulls: { get: async () => ({ data: { base: { sha: "head" } } }) },
        repos: { getContent },
        git,
      },
    };
    await expect(
      loadReviewUxConfigFromBase({
        client,
        owner: "owner",
        repo: "repo",
        prNumber: 7,
      }),
    ).rejects.toThrow("immutable base");
    expect(getContent).not.toHaveBeenCalled();
    client.rest.pulls.get = async () => ({
      data: { base: { sha: "a".repeat(40) } },
    });
    await expect(
      loadReviewUxConfigFromBase({
        client,
        owner: "owner",
        repo: "repo",
        prNumber: 7,
      }),
    ).rejects.toThrow("regular UTF-8");
  });
});
