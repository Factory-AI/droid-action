import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  REVIEW_CONFIG_KEYS,
  reviewConfigEnvironment,
  resolveReviewUxConfig,
} from "../src/core/review/config";

type Step = {
  id?: string;
  name: string;
  env?: Record<string, string>;
  run?: string;
  if?: string;
};
type Manifest = {
  inputs: Record<string, { default?: string; description: string }>;
  runs: { steps: Step[] };
};

describe("review configuration action wiring", () => {
  for (const file of [
    "action.yml",
    "review/action.yml",
    "security/action.yml",
    "prepare/action.yml",
  ]) {
    const manifest: Manifest = parse(
      readFileSync(join(import.meta.dir, "..", file), "utf8"),
    );
    it(`${file} documents effective defaults and keeps omission separate from explicit values`, () => {
      for (const key of REVIEW_CONFIG_KEYS) {
        expect(manifest.inputs[key]?.default).toBe("");
        expect(manifest.inputs[key]?.description.length).toBeGreaterThan(15);
      }
      const initial = manifest.runs.steps.find(
        (step) =>
          step.id ===
          (file === "action.yml" || file === "prepare/action.yml"
            ? "prepare"
            : "prompt"),
      );
      for (const key of REVIEW_CONFIG_KEYS)
        expect(initial?.env?.[key.toUpperCase()]).toBe(`\${{ inputs.${key} }}`);
    });
    it(`${file} does not overwrite resolved base config with a later blank input`, () => {
      let initialized = false;
      for (const step of manifest.runs.steps) {
        if (
          step.id ===
          (file === "action.yml" || file === "prepare/action.yml"
            ? "prepare"
            : "prompt")
        ) {
          initialized = true;
          continue;
        }
        if (!initialized) continue;
        for (const key of REVIEW_CONFIG_KEYS) {
          const value = step.env?.[key.toUpperCase()];
          if (value?.includes(`inputs.${key}`))
            expect(value).toContain(`env.${key.toUpperCase()}`);
        }
      }
    });
    it(`${file} exposes the separate check credential only to deterministic steps`, () => {
      const post = manifest.runs.steps.find(
        (step) => step.id === "post_review",
      );
      if (post)
        expect(post.env?.WORKFLOW_GITHUB_TOKEN).toBe("${{ github.token }}");
      for (const step of manifest.runs.steps.filter((step) =>
        step.run?.includes("base-action/src/index.ts"),
      )) {
        expect(step.env?.WORKFLOW_GITHUB_TOKEN).toBeUndefined();
      }
    });
    it(`${file} binds post-model configuration, executables and completion proof to runner outputs`, () => {
      const source =
        file === "action.yml" || file === "prepare/action.yml"
          ? "prepare"
          : "prompt";
      const validatorPreparation = manifest.runs.steps.find(
        (step) => step.id === "prepare_validator",
      );
      if (validatorPreparation)
        expect(validatorPreparation.env?.REVIEW_DEPTH).toBe(
          `\${{ fromJSON(steps.${source}.outputs.review_config_json).review_depth }}`,
        );
      for (const step of manifest.runs.steps.filter(
        (step) => step.env?.REVIEW_PUBLISHER_PATH,
      )) {
        expect(step.env?.REVIEW_CONFIG_JSON).toBe(
          `\${{ steps.${source}.outputs.review_config_json }}`,
        );
        expect(step.env?.REVIEW_INCREMENTAL_BASE_SHA).toBe(
          `\${{ steps.${source}.outputs.review_incremental_base_sha }}`,
        );
        expect(step.env?.REVIEW_SECURITY_ONLY).toBe(
          `\${{ steps.${source}.outputs.review_security_only }}`,
        );
        expect(step.env?.REVIEW_AUTOMATIC).toBe(
          `\${{ steps.${source}.outputs.review_automatic }}`,
        );
        expect(step.env?.REVIEW_RUNTIME_PATH).toBe(
          `\${{ steps.${source}.outputs.review_runtime_path }}`,
        );
        expect(step.env?.REVIEW_POSTED).toBe(
          "${{ steps.post_review.outputs.review_posted }}",
        );
        expect(step.env?.REVIEW_SKIPPED).toBe(
          `\${{ steps.${source}.outputs.review_skipped }}`,
        );
        expect(step.run).toContain("/usr/bin/env -i");
        expect(step.run).toContain("/usr/bin/sha256sum");
        expect(step.run).not.toContain("src/entrypoints/");
      }
    });
  }
  it("removes the unsupported label trigger default", () => {
    const manifest: Manifest = parse(
      readFileSync(join(import.meta.dir, "../action.yml"), "utf8"),
    );
    expect(manifest.inputs.label_trigger?.default).toBe("");
    expect(manifest.inputs.label_trigger?.description).toContain("Unsupported");
  });
  it("exports concrete runtime defaults for downstream steps", () => {
    expect(reviewConfigEnvironment(resolveReviewUxConfig())).toMatchObject({
      REVIEW_DEPTH: "deep",
      REVIEW_SUMMARY: "comment",
      REVIEW_BADGES: "text",
      REVIEW_REACTIONS: "true",
      REVIEW_MAX_AUTO_RUNS: "0",
      AUTOMATIC_REVIEW: "false",
    });
  });
});
