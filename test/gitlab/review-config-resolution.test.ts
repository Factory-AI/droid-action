import { describe, expect, it } from "bun:test";
import {
  downgradeUnsupportedTierAlias,
  withoutGitlabTokens,
} from "../../src/entrypoints/gitlab-prepare";
import { resolveReviewConfig } from "../../src/utils/review-depth";

describe("resolveReviewConfig (used by gitlab-prepare)", () => {
  it("uses deep preset by default", () => {
    expect(resolveReviewConfig()).toEqual({
      model: "openai-latest-balanced",
      reasoningEffort: "high",
    });
  });

  it("returns shallow preset for review_depth=shallow", () => {
    expect(resolveReviewConfig({ reviewDepth: "shallow" })).toEqual({
      model: "oss-latest-balanced",
      reasoningEffort: undefined,
    });
  });

  it("explicit reviewModel beats depth preset", () => {
    const out = resolveReviewConfig({
      reviewDepth: "shallow",
      reviewModel: "claude-sonnet-4-5-20250929",
    });
    expect(out.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("explicit reasoningEffort beats depth preset", () => {
    const out = resolveReviewConfig({
      reviewDepth: "deep",
      reasoningEffort: "medium",
    });
    expect(out.reasoningEffort).toBe("medium");
    expect(out.model).toBe("openai-latest-balanced");
  });

  it("both explicit overrides win simultaneously", () => {
    const out = resolveReviewConfig({
      reviewDepth: "shallow",
      reviewModel: "claude-opus-4-8",
      reasoningEffort: "low",
    });
    expect(out).toEqual({
      model: "claude-opus-4-8",
      reasoningEffort: "low",
    });
  });

  it("unknown reviewDepth falls back to shallow preset", () => {
    const out = resolveReviewConfig({ reviewDepth: "neutron-star" });
    expect(out.model).toBe("oss-latest-balanced");
  });
});

describe("downgradeUnsupportedTierAlias", () => {
  it("swaps an alias the installed CLI rejects for its concrete model", () => {
    expect(
      downgradeUnsupportedTierAlias(
        "openai-latest-balanced",
        () => "Invalid model: openai-latest-balanced\n",
      ),
    ).toBe("gpt-5.6-sol");
  });

  it("keeps an alias the installed CLI accepts", () => {
    expect(
      downgradeUnsupportedTierAlias(
        "openai-latest-balanced",
        () => "Available tools for GPT-6 Sol\n",
      ),
    ).toBe("openai-latest-balanced");
  });

  it("does not probe concrete models or an empty model", () => {
    const probe = () => {
      throw new Error("should not probe");
    };
    expect(downgradeUnsupportedTierAlias("gpt-5.2", probe)).toBe("gpt-5.2");
    expect(downgradeUnsupportedTierAlias(undefined, probe)).toBeUndefined();
  });
});

describe("withoutGitlabTokens", () => {
  it("drops GitLab credentials and keeps everything else", () => {
    const env = {
      GITLAB_TOKEN: "glpat-secret",
      OVERRIDE_GITLAB_TOKEN: "glpat-override",
      FACTORY_API_KEY: "fk-key",
      PATH: "/usr/bin",
    };
    expect(withoutGitlabTokens(env)).toEqual({
      FACTORY_API_KEY: "fk-key",
      PATH: "/usr/bin",
    });
    expect(env.GITLAB_TOKEN).toBe("glpat-secret");
  });
});
