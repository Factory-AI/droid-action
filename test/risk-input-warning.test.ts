import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

type Manifest = {
  inputs: Record<string, { default?: string }>;
  runs: { steps: { name: string; if?: string; run?: string }[] };
};

const manifest: Manifest = parse(
  readFileSync(join(import.meta.dir, "..", "action.yml"), "utf8"),
);

describe("risk inputs on a ref without risk assessment", () => {
  it.each(["automatic_risk_assessment", "risk_assessment"])(
    "declares %s so GitHub accepts it",
    (name) => {
      expect(manifest.inputs[name]).toBeDefined();
    },
  );

  it("warns first when either risk input is turned on", () => {
    const [first] = manifest.runs.steps;
    expect(first?.if).toBe(
      "inputs.automatic_risk_assessment == 'true' || inputs.risk_assessment == 'true'",
    );
    expect(first?.run).toContain("::warning");
    expect(first?.run).toContain("Factory-AI/droid-action@dev-internal");
  });
});
