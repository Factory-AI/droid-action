import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import { parseAppTokenPermissions } from "../src/github/token-permissions";

type Step = {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  shell?: string;
  run?: string;
  env?: Record<string, string>;
};

const action: { runs: { steps: Step[] } } = parse(
  readFileSync(join(import.meta.dir, "..", "risk", "action.yml"), "utf8"),
);
const steps = action.runs.steps;

function step(id: string): Step {
  const found = steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`risk/action.yml has no step with id ${id}`);
  return found;
}

function named(name: string): Step {
  const found = steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`risk/action.yml has no step named ${name}`);
  return found;
}

const OIDC_AND_RUNTIME_CREDENTIALS = [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_RUNTIME_TOKEN",
];
const HARDENED_SHELL = "/bin/bash --noprofile --norc -p -eo pipefail {0}";

// The judge session runs pull request code, so what reaches it is the whole
// security boundary of this action.
describe("risk action wiring", () => {
  it("mints a GitHub token that can only read", () => {
    const token = step("token");
    expect(token.run).toContain("src/entrypoints/get-token.ts");
    const permissions = parseAppTokenPermissions(
      token.env?.APP_TOKEN_PERMISSIONS,
    );
    expect(permissions).toEqual({
      contents: "read",
      pull_requests: "read",
      issues: "read",
      checks: "read",
      statuses: "read",
    });
  });

  it("drops the credentials that could mint a broader token before the judge starts", () => {
    const assess = step("assess");
    expect(assess.run).toContain("src/entrypoints/risk-assess.ts");
    expect(assess.run?.trimStart().startsWith("exec /usr/bin/env ")).toBe(true);
    for (const name of OIDC_AND_RUNTIME_CREDENTIALS) {
      expect(assess.run).toContain(`-u ${name} `);
    }
  });

  it("gives the judge step the minted read token and never a token of the caller's", () => {
    const env = step("assess").env ?? {};
    expect(env.GH_TOKEN).toBe(
      "${{ steps.token.outputs.github_token || (steps.token.outputs.use_workflow_token == 'true' && github.token) || '' }}",
    );
    expect(env.GITHUB_TOKEN).toBeUndefined();
    for (const value of Object.values(env)) {
      expect(value).not.toContain("secrets.");
    }
  });

  it("reports a failed judge run, and leaves a cancelled one to the run that replaced it", () => {
    for (const id of ["assess", "settle"]) {
      expect(step(id).if).toBe(
        "${{ !cancelled() && steps.begin.outputs.action == 'judge' }}",
      );
    }
  });

  it("revokes the minted token whatever happened, and only that token", () => {
    const revoke = named("Revoke judge read token");
    expect(revoke.if).toBe(
      "always() && steps.token.outputs.github_token != ''",
    );
    expect(revoke.env?.GITHUB_TOKEN).toBe(
      "${{ steps.token.outputs.github_token }}",
    );
    expect(steps.indexOf(revoke)).toBeGreaterThan(
      steps.indexOf(step("assess")),
    );
  });

  it("runs nothing from the action's checkout or PATH once the judge has run", () => {
    const afterJudge = steps.slice(steps.indexOf(step("assess")) + 1);
    expect(afterJudge.map((candidate) => candidate.name)).toEqual([
      "Revoke judge read token",
      "Report to Factory",
    ]);
    for (const candidate of afterJudge) {
      expect(candidate.run).not.toContain("github.action_path");
      expect(candidate.run).not.toMatch(/(^|\s)bun\s/);
      expect(candidate.run).toContain("/usr/bin/env -i");
      expect(candidate.run).toContain(
        '"$TRUSTED_RUNTIME_PATH" --config=/dev/null --env-file=/dev/null run "$TRUSTED_TAIL_PATH"',
      );
    }
  });

  it("binds each step after the judge to a script frozen before the judge", () => {
    expect(named("Revoke judge read token").env).toMatchObject({
      TRUSTED_TAIL_PATH:
        "${{ steps.token.outputs.review_revoke_publisher_path }}",
      TRUSTED_TAIL_SHA256:
        "${{ steps.token.outputs.review_revoke_publisher_sha256 }}",
      TRUSTED_RUNTIME_PATH: "${{ steps.token.outputs.review_runtime_path }}",
      TRUSTED_RUNTIME_SHA256:
        "${{ steps.token.outputs.review_runtime_sha256 }}",
    });
    expect(step("settle").env).toMatchObject({
      TRUSTED_TAIL_PATH: "${{ steps.begin.outputs.settle_path }}",
      TRUSTED_TAIL_SHA256: "${{ steps.begin.outputs.settle_sha256 }}",
      TRUSTED_RUNTIME_PATH: "${{ steps.begin.outputs.runtime_path }}",
      TRUSTED_RUNTIME_SHA256: "${{ steps.begin.outputs.runtime_sha256 }}",
    });
  });

  it("runs every script without the caller's Bun configuration, in a shell that loads no profile", () => {
    const scripted = steps.filter((candidate) =>
      candidate.run?.includes("--config=/dev/null"),
    );
    expect(scripted.map((candidate) => candidate.id ?? candidate.name)).toEqual(
      ["begin", "token", "assess", "Revoke judge read token", "settle"],
    );
    for (const candidate of scripted) {
      expect(candidate.shell).toBe(HARDENED_SHELL);
      expect(candidate.run).toContain(
        "--config=/dev/null --env-file=/dev/null run",
      );
      for (const name of [
        "BASH_ENV",
        "NODE_OPTIONS",
        "BUN_OPTIONS",
        "LD_PRELOAD",
      ]) {
        expect(candidate.env?.[name]).toBe("");
      }
    }
  });

  it("installs and runs nothing of the judge unless Factory asked for one", () => {
    const afterBegin = steps.slice(steps.indexOf(step("begin")) + 1);
    expect(afterBegin.length).toBeGreaterThan(0);
    for (const candidate of afterBegin) {
      expect(candidate.if).toMatch(
        /steps\.begin\.outputs\.action == 'judge'|steps\.token\.outputs\.github_token != ''/,
      );
    }
  });
});
