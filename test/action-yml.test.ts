import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const actionYml = readFileSync(
  join(import.meta.dir, "..", "action.yml"),
  "utf8",
);

describe("action.yml debug artifact invariants", () => {
  it("loads the Droid composite action metadata", () => {
    expect(actionYml.length).toBeGreaterThan(0);
    expect(actionYml).toContain("runs:");
    expect(actionYml).toContain('using: "composite"');
  });

  it("does not copy raw Factory runtime state", () => {
    expect(actionYml).not.toContain("Collect .factory debug files");
    expect(actionYml).not.toMatch(/cp\s+-[rR]\s+["']?\$HOME\/?\.factory/);
  });

  it("does not upload raw prompt or Factory runtime trees directly", () => {
    expect(actionYml).not.toContain("Upload debug artifacts");
    expect(actionYml).not.toMatch(
      /\$\{\{\s*runner\.temp\s*\}\}\/\.factory(?:\/\*\*)?/,
    );
    expect(actionYml).not.toMatch(
      /\$\{\{\s*runner\.temp\s*\}\}\/droid-prompts\/\*\*/,
    );
    expect(actionYml).not.toMatch(
      /name:\s*droid-review-debug-\$\{\{\s*github\.run_id\s*\}/,
    );
  });

  it("does not enable hidden-file uploads for raw Droid runtime artifacts", () => {
    expect(actionYml).not.toMatch(
      /include-hidden-files:\s*true[\s\S]{0,500}(?:\.factory|droid-prompts)/,
    );
    expect(actionYml).not.toMatch(
      /(?:\.factory|droid-prompts)[\s\S]{0,500}include-hidden-files:\s*true/,
    );
  });

  it("keeps redacted upload-artifact usage SHA-pinned", () => {
    expect(actionYml).toContain("Upload redacted debug artifacts");
    expect(actionYml).not.toContain("FACTORY_HOME: $HOME/.factory");
    expect(actionYml).toContain(
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    );
    expect(actionYml).toContain(
      "path: ${{ runner.temp }}/droid-debug-artifacts/**",
    );
    expect(actionYml).toContain("if-no-files-found: error");
  });
});
