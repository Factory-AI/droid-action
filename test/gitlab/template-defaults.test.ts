import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAllDocuments } from "yaml";

const TEMPLATE_PATH = path.join(
  import.meta.dir,
  "../../templates/droid-review.yml",
);

function specInputs(): Record<string, { default?: unknown }> {
  const [spec] = parseAllDocuments(readFileSync(TEMPLATE_PATH, "utf8"));
  return spec!.toJS().spec.inputs;
}

describe("droid-review GitLab template defaults", () => {
  it("enables automatic security review by default", () => {
    expect(specInputs().automatic_security_review?.default).toBe("true");
  });

  it("enables automatic code review by default", () => {
    expect(specInputs().automatic_review?.default).toBe("true");
  });
});
