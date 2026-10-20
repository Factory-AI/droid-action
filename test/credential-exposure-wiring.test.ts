import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const read = (relativePath: string): string =>
  readFileSync(join(root, relativePath), "utf8");

const ACTIONS = [
  "action.yml",
  "prepare/action.yml",
  "review/action.yml",
  "security/action.yml",
  "base-action/action.yml",
].filter((relativePath) => existsSync(join(root, relativePath)));

const stepBlocks = (yaml: string): string[] =>
  yaml.split(/\n(?= {4}- name: )/).slice(1);

// Workflow artifacts are downloadable by anyone who can read the repository's
// Actions runs. ~/.factory/mcp.json holds the GitHub App token, so no artifact
// may include it, and the token must not outlive the run.
describe("credential exposure wiring", () => {
  it("uploads the debug artifact only on request, from the redacted staging directory", () => {
    const action = read("action.yml");
    expect(action).toMatch(
      /\n {2}upload_debug_artifacts:\n(?: {4}[^\n]*\n)*? {4}default: "false"\n/,
    );
    const collect = stepBlocks(action).find((step) =>
      step.includes("id: collect_debug"),
    );
    expect(collect).toBeDefined();
    expect(collect).toContain("inputs.upload_debug_artifacts == 'true'");
    expect(collect).toContain("collect-debug-artifacts.ts");
    const upload = stepBlocks(action).find((step) =>
      step.includes("uses: actions/upload-artifact@"),
    );
    expect(upload).toContain("steps.collect_debug.outcome == 'success'");
    expect(upload).toContain(
      "path: ${{ runner.temp }}/droid-debug-artifacts/\n",
    );
  });

  for (const relativePath of ACTIONS) {
    it(`never copies or uploads ~/.factory wholesale in ${relativePath}`, () => {
      const action = read(relativePath);
      expect(action).not.toMatch(/cp\s+-r\s+"?(\$HOME|~)\/\.factory"?(\s|$)/);
      expect(action).not.toContain("runner.temp }}/.factory");
    });

    it(`keeps Bun from loading the caller's bunfig.toml or .env in ${relativePath}`, () => {
      expect(read(relativePath)).not.toMatch(/(?<![\w-])bun run \$/);
    });
  }

  for (const relativePath of [
    "action.yml",
    "review/action.yml",
    "security/action.yml",
  ]) {
    it(`revokes the minted App token as the last step of ${relativePath}`, () => {
      const last = stepBlocks(read(relativePath)).at(-1) ?? "";
      expect(last).toContain("- name: Revoke GitHub App token");
      expect(last).toContain("if: always() && inputs.github_token == ''");
      expect(last).toContain("revoke-github-token.ts");
      expect(last).toMatch(
        /GITHUB_TOKEN: \$\{\{ steps\.(prepare|token)\.outputs\.github_token \}\}/,
      );
      expect(last).toContain(
        "OVERRIDE_GITHUB_TOKEN: ${{ inputs.github_token }}",
      );
    });
  }
});
