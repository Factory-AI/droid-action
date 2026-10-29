import { describe, expect, it } from "bun:test";
import { reviewPromptSettingsFromEnvironment } from "../../../src/core/review/prompts/settings";

describe("trusted review prompt settings", () => {
  it("maps resolved environment settings without reloading head files", () => {
    const settings = reviewPromptSettingsFromEnvironment({
      REVIEW_DIAGRAM: "off",
      REVIEW_EFFORT: "true",
      REVIEW_SUGGEST_REVIEWERS: "true",
      REVIEW_PRE_MERGE_CHECKS: "title,linked_issue",
      SECURITY_SEVERITY_THRESHOLD: "high",
      SECURITY_BLOCK_ON_CRITICAL: "false",
      SECURITY_BLOCK_ON_HIGH: "true",
    });
    expect(settings).toMatchObject({
      diagram: "off",
      effort: true,
      suggestReviewers: true,
      preMergeChecks: ["title", "linked_issue"],
      securitySeverityThreshold: "high",
      securityBlockOnCritical: false,
      securityBlockOnHigh: true,
    });
  });
});
