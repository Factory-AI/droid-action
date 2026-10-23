import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const action = parse(
  readFileSync(join(import.meta.dir, "../prepare/action.yml"), "utf8"),
);
const script: string = action.runs.steps.find(
  (step: { id?: string }) => step.id === "detect",
).run;

describe("prepare action review-output fallback", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "prepare-fallback-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    ["both inputs omitted", undefined, undefined, "", "", "false", "false"],
    ["inherited security", "true", undefined, "", "", "true", "true"],
    ["empty security", "true", "", "", "", "true", "true"],
    ["explicit opt-out", "true", "false", "", "", "true", "false"],
    ["security only", "false", "true", "", "", "false", "true"],
    ["deduplicated security", "true", "true", "true", "false", "true", "false"],
    ["both prepared off", "true", "true", "false", "false", "false", "false"],
    ["prepared security on", "false", "false", "true", "true", "true", "true"],
  ])(
    "%s",
    (
      _name,
      codeInput,
      securityInput,
      preparedCode,
      preparedSecurity,
      expectedCode,
      expectedSecurity,
    ) => {
      const values: Record<string, string> = {
        "inputs.automatic_review":
          codeInput ?? action.inputs.automatic_review.default ?? "",
        "inputs.automatic_security_review":
          securityInput ??
          action.inputs.automatic_security_review.default ??
          "",
        "steps.prepare.outputs.run_code_review": preparedCode!,
        "steps.prepare.outputs.run_security_review": preparedSecurity!,
      };
      const rendered = script.replace(
        /\$\{\{\s*([^}]+?)\s*\}\}/g,
        (_, key: string) => {
          if (!(key in values))
            throw new Error(`Unexpected expression: ${key}`);
          return values[key]!;
        },
      );
      const outputPath = join(tempDir, "output");
      const result = Bun.spawnSync(["bash", "-c", rendered], {
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: outputPath },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(readFileSync(outputPath, "utf8")).toBe(
        `run_code_review=${expectedCode}\nrun_security_review=${expectedSecurity}\n`,
      );
    },
  );
});
