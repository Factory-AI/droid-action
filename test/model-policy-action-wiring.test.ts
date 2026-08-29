import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

type ActionStep = {
  name?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type ActionDefinition = {
  inputs?: Record<string, { default?: string }>;
  runs?: { steps?: ActionStep[] };
};

const repositoryRoot = join(import.meta.dir, "..");

function readAction(path: string): ActionDefinition {
  return parse(readFileSync(join(repositoryRoot, path), "utf8"));
}

function getStep(action: ActionDefinition, name: string): ActionStep {
  const step = action.runs?.steps?.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Action step not found: ${name}`);
  }
  return step;
}

describe("model policy fallback action wiring", () => {
  const actionCases = [
    {
      path: "action.yml",
      prepareSteps: ["Prepare action", "Prepare validator"],
      executionSteps: ["Run Droid Exec", "Run Droid Exec (validator)"],
    },
    {
      path: "review/action.yml",
      prepareSteps: ["Generate Review Prompt", "Prepare Validator"],
      executionSteps: ["Run Code Review", "Run Validator"],
    },
    {
      path: "security/action.yml",
      prepareSteps: ["Generate Security Prompt", "Prepare Validator"],
      executionSteps: ["Run Security Review", "Run Validator"],
    },
  ];

  for (const { path, prepareSteps, executionSteps } of actionCases) {
    it(`forwards strict mode through every ${path} pass`, () => {
      const action = readAction(path);

      expect(action.inputs?.model_policy_fallback?.default).toBe(
        "organization-default",
      );
      for (const stepName of prepareSteps) {
        const env = getStep(action, stepName).env;
        expect(env?.MODEL_POLICY_FALLBACK).toBe(
          "${{ inputs.model_policy_fallback }}",
        );
        expect(env?.FACTORY_API_KEY).toBe("${{ inputs.factory_api_key }}");
      }
      for (const stepName of executionSteps) {
        expect(getStep(action, stepName).env?.INPUT_MODEL_POLICY_FALLBACK).toBe(
          "${{ inputs.model_policy_fallback }}",
        );
      }
    });
  }

  it("forwards strict mode through the standalone base action", () => {
    const action = readAction("base-action/action.yml");

    expect(action.inputs?.model_policy_fallback?.default).toBe(
      "organization-default",
    );
    expect(
      getStep(action, "Run Droid Exec Action").env?.INPUT_MODEL_POLICY_FALLBACK,
    ).toBe("${{ inputs.model_policy_fallback }}");
  });

  it("selects the security model for security validators", () => {
    const mainAction = readAction("action.yml");
    const securityAction = readAction("security/action.yml");

    expect(getStep(mainAction, "Prepare validator").env?.REVIEW_MODEL).toBe(
      "${{ steps.prepare.outputs.run_security_review == 'true' && inputs.security_model || inputs.review_model }}",
    );
    expect(getStep(securityAction, "Prepare Validator").env?.REVIEW_MODEL).toBe(
      "${{ inputs.security_model || inputs.review_model }}",
    );
  });

  it("uses a unique debug artifact name for each action invocation", () => {
    const action = readAction("action.yml");

    expect(getStep(action, "Upload debug artifacts").with?.name).toBe(
      "droid-review-debug-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}-${{ strategy.job-index || 0 }}-${{ github.action }}",
    );
  });
});
