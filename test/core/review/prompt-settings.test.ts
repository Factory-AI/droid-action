import { describe, expect, it } from "bun:test";
import { reviewPromptSettingsFromEnvironment } from "../../../src/core/review/prompts/settings";
import { generateValidatorPrompt } from "../../../src/core/review/prompts/validator";
import { generateCandidatesPrompt } from "../../../src/core/review/prompts/candidates";
import type { ReviewPromptContext } from "../../../src/core/review/prompts/types";
import { GITHUB_TERMINOLOGY } from "../../../src/create-prompt/terminology";

function context(): ReviewPromptContext {
  return {
    terminology: GITHUB_TERMINOLOGY,
    postingMode: "file",
    entityNumber: 42,
    repoOrProject: "example/repo",
    headRef: "feature",
    headSha: "abcdef0123456789abcdef0123456789abcdef0123",
    baseRef: "main",
    diffPath: "/tmp/pr.diff",
    commentsPath: "/tmp/comments.json",
    descriptionPath: "/tmp/description.txt",
    candidatesPath: "/tmp/candidates.json",
    validatedPath: "/tmp/validated.json",
    includeSuggestions: true,
    securityReviewEnabled: true,
  };
}
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
    const prompt = generateValidatorPrompt({
      ...context(),
      reviewSettings: settings,
    });
    expect(prompt).toContain('"threshold": "high"');
    expect(prompt).toContain('"blockOnCritical": false');
    expect(prompt).toContain('"diagram": "off"');
    expect(prompt).toContain("Emit effort only when effort is enabled");
    expect(prompt).toContain("optionalSuggestion: true");
    expect(prompt).toContain("Never infer optionality from P2 alone");
  });
  it("keeps prior finding decisions separate and requires eligible IDs plus evidence", () => {
    const ctx = { ...context(), priorFindingsPath: "/tmp/prior.json" };
    for (const prompt of [
      generateCandidatesPrompt(ctx),
      generateValidatorPrompt(ctx),
    ]) {
      expect(prompt).toContain("/tmp/prior.json");
      expect(prompt).toContain("human-resolved/dismissed");
    }
    const validator = generateValidatorPrompt(ctx);
    expect(validator).toContain("findingResolutions");
    expect(validator).toContain("eligibleFixedIds");
    expect(validator).toContain("absent candidates do NOT prove a fix");
    expect(validator).toContain("one-to-one");
  });
  it("redacts recognizable secrets from all generated prompt content", () => {
    const secret = `fk-${"x".repeat(25)}`;
    const ctx = { ...context(), sourceNote: secret };
    expect(generateCandidatesPrompt(ctx)).not.toContain(secret);
    expect(generateValidatorPrompt(ctx)).not.toContain(secret);
  });
});
