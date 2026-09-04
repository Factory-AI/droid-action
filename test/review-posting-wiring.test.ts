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
  it("wires candidate/validator caps and deterministic posting in the main action", () => {
    const action = loadAction("action.yml");

    expect(action.inputs.review_candidates_max_turns.default).toBe("100");
    expect(action.inputs.review_validator_max_turns.default).toBe("40");
    expect(stepById(action, "droid").env.INPUT_MAX_TURNS).toContain(
      "review_candidates_max_turns",
    );
    expect(stepById(action, "droid_validator").env.INPUT_MAX_TURNS).toContain(
      "review_validator_max_turns",
    );
    expect(stepById(action, "post_review").run).toContain(
      "github-post-review.ts",
    );
    expect(stepById(action, "post_review").env.REVIEW_VALIDATED_PATH).toContain(
      "review_validated_path",
    );
  });

  for (const relativePath of ["review/action.yml", "security/action.yml"]) {
    it(`wires both caps and posting in ${relativePath}`, () => {
      const action = loadAction(relativePath);

      expect(action.inputs.candidates_max_turns.default).toBe("100");
      expect(action.inputs.validator_max_turns.default).toBe("40");
      expect(stepById(action, "review").env.INPUT_MAX_TURNS).toContain(
        "candidates_max_turns",
      );
      expect(stepById(action, "validator").env.INPUT_MAX_TURNS).toContain(
        "validator_max_turns",
      );
      expect(stepById(action, "post_review").run).toContain(
        "github-post-review.ts",
      );
      expect(action.outputs.conclusion.value).toContain("post_review");
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
