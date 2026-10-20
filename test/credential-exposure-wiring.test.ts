import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse, parseAllDocuments } from "yaml";
import { GITHUB_CREDENTIAL_ENV_NAMES } from "../src/utils/redact-credentials";

const root = join(import.meta.dir, "..");
const loadAction = (relativePath: string): any =>
  parse(readFileSync(join(root, relativePath), "utf8"));
const stepById = (action: any, id: string): any =>
  action.runs.steps.find((step: any) => step.id === id);

const ACTIONS = [
  "action.yml",
  "prepare/action.yml",
  "review/action.yml",
  "security/action.yml",
  "base-action/action.yml",
  "review-guidelines/action.yml",
  "review-guidelines/publish/action.yml",
];

// Workflow artifacts are downloadable by anyone who can read the repository's
// Actions runs. ~/.factory/mcp.json holds the GitHub App token, so no artifact
// may include it, and the token must not outlive the run.
describe("credential exposure wiring", () => {
  it("uploads the GitHub debug artifact only on request, from the redacted staging directory", () => {
    const action = loadAction("action.yml");
    expect(action.inputs.upload_debug_artifacts.default).toBe("false");

    const collect = stepById(action, "collect_debug");
    expect(collect.if).toContain("inputs.upload_debug_artifacts == 'true'");
    expect(collect.run).toContain("collect-debug-artifacts.ts");
    expect(collect.env.DEBUG_ARTIFACTS_DIR).toBe(
      "${{ runner.temp }}/droid-debug-artifacts",
    );

    const upload = action.runs.steps.find((step: any) =>
      String(step.uses ?? "").startsWith("actions/upload-artifact@"),
    );
    expect(upload.if).toContain("steps.collect_debug.outcome == 'success'");
    expect(upload.with.path).toBe("${{ runner.temp }}/droid-debug-artifacts/");
  });

  it("hands the collector every credential the job holds", () => {
    const collect = stepById(loadAction("action.yml"), "collect_debug");
    // The runner sets these itself, and the action never sets GH_TOKEN.
    const notSetByAction = new Set([
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "ACTIONS_RUNTIME_TOKEN",
      "GH_TOKEN",
    ]);
    for (const name of GITHUB_CREDENTIAL_ENV_NAMES) {
      if (notSetByAction.has(name)) continue;
      expect(collect.env[name]).toBeDefined();
    }
  });

  for (const relativePath of ACTIONS) {
    it(`never copies or uploads ~/.factory wholesale in ${relativePath}`, () => {
      const action = loadAction(relativePath);
      for (const step of action.runs.steps) {
        expect(String(step.run ?? "")).not.toMatch(
          /cp\s+-r\s+"?(\$HOME|~)\/\.factory"?(\s|$)/,
        );
        if (String(step.uses ?? "").startsWith("actions/upload-artifact@")) {
          expect(String(step.with.path)).not.toContain(".factory");
        }
      }
    });
  }

  for (const relativePath of [
    "action.yml",
    "review/action.yml",
    "security/action.yml",
  ]) {
    it(`revokes the minted App token as the last step of ${relativePath}`, () => {
      const action = loadAction(relativePath);
      const last = action.runs.steps.at(-1);
      expect(last.name).toBe("Revoke GitHub App token");
      expect(last.if).toContain("always()");
      expect(last.if).toContain("inputs.github_token == ''");
      expect(last.run).toContain("revoke-github-token.ts");
      expect(last.env.GITHUB_TOKEN).toMatch(
        /steps\.(prepare|token)\.outputs\.github_token/,
      );
      expect(last.env.OVERRIDE_GITHUB_TOKEN).toBe("${{ inputs.github_token }}");
    });
  }

  it("stages the GitLab debug artifact through the redacting collector", () => {
    const [, jobs] = parseAllDocuments(
      readFileSync(join(root, "templates/droid-review.yml"), "utf8"),
    ).map((doc) => doc.toJS());
    const afterScript: string[] = jobs["droid-review"].after_script;
    expect(
      afterScript.some((line) =>
        line.includes("gitlab-collect-debug-artifacts.ts"),
      ),
    ).toBe(true);
    expect(afterScript.join("\n")).not.toContain("cp -r /tmp/droid-prompts");
    expect(jobs["droid-review"].artifacts.paths).toEqual([".droid-debug/"]);
  });
});
