import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

const root = join(import.meta.dir, "..");
const loadAction = (relativePath: string): any =>
  parse(readFileSync(join(root, relativePath), "utf8"));

const stepById = (action: any, id: string): any =>
  action.runs.steps.find((step: any) => step.id === id);

describe("review safety wiring", () => {
  for (const relativePath of ["action.yml", "prepare/action.yml"]) {
    it(`forwards the security choice to preparation in ${relativePath}`, () => {
      const action = loadAction(relativePath);

      expect(stepById(action, "prepare").env.AUTOMATIC_SECURITY_REVIEW).toBe(
        "${{ inputs.automatic_security_review }}",
      );
    });
  }

  it("uses the actual security result when updating the final comment", () => {
    const action = loadAction("action.yml");
    const updateComment = action.runs.steps.find(
      (step: any) => step.name === "Update comment with job link",
    );

    expect(updateComment.env.AUTOMATIC_SECURITY_REVIEW).toBe(
      "${{ steps.prepare.outputs.run_security_review }}",
    );
  });

  it("publishes what the review step answered, and keeps the base runner out of a review, in the main action", () => {
    const action = loadAction("action.yml");

    expect(stepById(action, "droid").if).toContain(
      "steps.prepare.outputs.run_code_review != 'true'",
    );
    expect(stepById(action, "post_review").if).toContain(
      "steps.review.outputs.conclusion == 'success'",
    );
    expect(stepById(action, "post_review").run).toContain(
      '"$REVIEW_PUBLISHER_PATH"',
    );
    expect(stepById(action, "post_review").env.REVIEW_PUBLISHER_PATH).toBe(
      "${{ steps.prepare.outputs.review_post_publisher_path }}",
    );
    expect(stepById(action, "post_review").env.REVIEW_VALIDATED_PATH).toBe(
      stepById(action, "review").env.REVIEW_VALIDATED_PATH,
    );
  });

  for (const relativePath of ["review/action.yml", "security/action.yml"]) {
    it(`publishes what the review step answered in ${relativePath}`, () => {
      const action = loadAction(relativePath);

      expect(stepById(action, "post_review").if).toContain(
        "steps.review.outputs.conclusion == 'success'",
      );
      expect(stepById(action, "post_review").run).toContain(
        '"$REVIEW_PUBLISHER_PATH"',
      );
      expect(stepById(action, "post_review").env.REVIEW_PUBLISHER_PATH).toBe(
        "${{ steps.prepare.outputs.review_post_publisher_path }}",
      );
      expect(stepById(action, "post_review").env.REVIEW_VALIDATED_PATH).toBe(
        stepById(action, "review").env.REVIEW_VALIDATED_PATH,
      );
      expect(action.outputs.conclusion.value).toContain("post_review");
    });
  }

  // Both passes of a review run pull request code, so the step that starts
  // them is never given a GitHub credential or the token the worker was
  // downloaded with; only the deterministic post step holds one.
  for (const relativePath of [
    "action.yml",
    "review/action.yml",
    "security/action.yml",
  ]) {
    it(`gives the review step no GitHub or download token in ${relativePath}`, () => {
      const action = loadAction(relativePath);
      const review = stepById(action, "review");

      expect(JSON.stringify([review.env, review.run])).not.toMatch(
        /GITHUB_TOKEN|GH_TOKEN|WORKER_TOKEN|github\.token|inputs\.github_token/,
      );
      expect(stepById(action, "post_review").env.GITHUB_TOKEN).toBeDefined();
    });
  }
  it("exposes max_turns through the reusable base action", () => {
    const action = loadAction("base-action/action.yml");

    expect(action.inputs.max_turns).toBeDefined();
    expect(stepById(action, "run_droid").env.INPUT_MAX_TURNS).toContain(
      "max_turns",
    );
  });
});
