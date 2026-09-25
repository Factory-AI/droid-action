import { describe, expect, it } from "bun:test";
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
