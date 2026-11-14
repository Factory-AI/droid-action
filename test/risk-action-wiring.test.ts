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

function load(relativePath: string): Step[] {
  const action: { runs: { steps: Step[] } } = parse(
    readFileSync(join(import.meta.dir, "..", relativePath), "utf8"),
  );
  return action.runs.steps;
}

const rootSteps = load("action.yml");
const rootRiskStart = rootSteps.findIndex(
  (candidate) => candidate.id === "risk_begin",
);

// The same steps ship twice: as the standalone sub-action and as the tail of
// the full action. `p` is the prefix the full action gives their ids.
const variants = [
  {
    file: "risk/action.yml",
    p: "",
    report: "Report to Factory",
    steps: load("risk/action.yml"),
  },
  {
    file: "action.yml",
    p: "risk_",
    report: "Report risk result to Factory",
    steps: rootSteps.slice(rootRiskStart),
  },
];

const OIDC_AND_RUNTIME_CREDENTIALS = [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_RUNTIME_TOKEN",
];
const HARDENED_SHELL = "/bin/bash --noprofile --norc -p -eo pipefail {0}";

// The judge session runs pull request code, so what reaches it is the whole
// security boundary of this action.
describe.each(variants)(
  "risk wiring of $file",
  ({ file, p, report, steps }) => {
    function step(id: string): Step {
      const found = steps.find((candidate) => candidate.id === p + id);
      if (!found) throw new Error(`${file} has no step with id ${p}${id}`);
      return found;
    }

    // The full action freezes every risk script in its prepare step, before
    // the review; the standalone action freezes each one where it is needed.
    const frozenBy = (owner: string) => (p ? "prepare" : owner);

    function named(name: string): Step {
      const found = steps.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`${file} has no step named ${name}`);
      return found;
    }

    it("mints a GitHub token that can only read", () => {
      const token = step("token");
      if (!p) expect(token.run).toContain("src/entrypoints/get-token.ts");
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
      if (!p) expect(assess.run).toContain("src/entrypoints/risk-assess.ts");
      // The one command that starts a script is an `exec` through env, so no
      // shell is left holding the credentials.
      const launches = assess.run
        ?.split("\n")
        .filter((line) => /^\s*exec\s/.test(line));
      expect(launches).toHaveLength(1);
      expect(launches?.[0]?.trimStart().startsWith("exec /usr/bin/env ")).toBe(
        true,
      );
      for (const name of OIDC_AND_RUNTIME_CREDENTIALS) {
        expect(assess.run).toContain(`-u ${name} `);
      }
    });

    it("gives the judge step the minted read token and never a token of the caller's", () => {
      const env = step("assess").env ?? {};
      expect(env.GH_TOKEN).toBe(
        `\${{ steps.${p}token.outputs.github_token || (steps.${p}token.outputs.use_workflow_token == 'true' && github.token) || '' }}`,
      );
      expect(env.GITHUB_TOKEN).toBeUndefined();
      for (const value of Object.values(env)) {
        expect(value).not.toContain("secrets.");
      }
    });

    it("reports a failed judge run, and leaves a cancelled one to the run that replaced it", () => {
      for (const id of ["assess", "settle"]) {
        expect(step(id).if).toBe(
          `\${{ !cancelled() && steps.${p}begin.outputs.action == 'judge' }}`,
        );
      }
    });

    it("revokes the minted token whatever happened, and only that token", () => {
      const revoke = named("Revoke judge read token");
      expect(revoke.if).toBe(
        `always() && steps.${p}token.outputs.github_token != ''`,
      );
      expect(revoke.env?.GITHUB_TOKEN).toBe(
        `\${{ steps.${p}token.outputs.github_token }}`,
      );
      expect(steps.indexOf(revoke)).toBeGreaterThan(
        steps.indexOf(step("assess")),
      );
    });

    it("runs nothing from the action's checkout or PATH once the judge has run", () => {
      const afterJudge = steps.slice(steps.indexOf(step("assess")) + 1);
      expect(afterJudge.map((candidate) => candidate.name)).toEqual([
        "Revoke judge read token",
        report,
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
        TRUSTED_TAIL_PATH: `\${{ steps.${frozenBy("token")}.outputs.review_revoke_publisher_path }}`,
        TRUSTED_TAIL_SHA256: `\${{ steps.${frozenBy("token")}.outputs.review_revoke_publisher_sha256 }}`,
        TRUSTED_RUNTIME_PATH: `\${{ steps.${frozenBy("token")}.outputs.review_runtime_path }}`,
        TRUSTED_RUNTIME_SHA256: `\${{ steps.${frozenBy("token")}.outputs.review_runtime_sha256 }}`,
      });
      expect(step("settle").env).toMatchObject({
        TRUSTED_TAIL_PATH: `\${{ steps.${frozenBy("begin")}.outputs.review_settle_publisher_path }}`,
        TRUSTED_TAIL_SHA256: `\${{ steps.${frozenBy("begin")}.outputs.review_settle_publisher_sha256 }}`,
        TRUSTED_RUNTIME_PATH: `\${{ steps.${frozenBy("begin")}.outputs.review_runtime_path }}`,
        TRUSTED_RUNTIME_SHA256: `\${{ steps.${frozenBy("begin")}.outputs.review_runtime_sha256 }}`,
      });
    });

    it("runs every script without the caller's Bun configuration, in a shell that loads no profile", () => {
      const scripted = steps.filter((candidate) =>
        candidate.run?.includes("--config=/dev/null"),
      );
      expect(
        scripted.map((candidate) => candidate.id ?? candidate.name),
      ).toEqual([
        `${p}begin`,
        `${p}token`,
        `${p}assess`,
        "Revoke judge read token",
        `${p}settle`,
      ]);
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
          new RegExp(
            `steps\\.${p}begin\\.outputs\\.action == 'judge'|steps\\.${p}token\\.outputs\\.github_token != ''`,
          ),
        );
      }
    });
  },
);

describe("risk assessment inside the full action", () => {
  const before = rootSteps.slice(0, rootRiskStart);
  const risk = rootSteps.slice(rootRiskStart);
  const begin = risk[0]!;

  it("is off unless the caller asks for it", () => {
    expect(rootRiskStart).toBeGreaterThan(0);
    expect(begin.if).toBe(
      "${{ !cancelled() && inputs.risk_assessment == 'true' }}",
    );
    for (const candidate of before) {
      const text = JSON.stringify(candidate);
      // The prepare step is told only so it can freeze the risk scripts.
      expect(text.replace("${{ inputs.risk_assessment }}", "")).not.toContain(
        "inputs.risk_",
      );
    }
    expect(
      before.find((candidate) => candidate.id === "prepare")?.env,
    ).toMatchObject({ RISK_ASSESSMENT: "${{ inputs.risk_assessment }}" });
  });

  it("starts only after the review's App token is revoked, and never reads it", () => {
    expect(before.at(-1)?.name).toBe("Revoke GitHub App token");
    for (const candidate of risk) {
      expect(JSON.stringify(candidate)).not.toContain(
        "steps.prepare.outputs.github_token",
      );
      expect(JSON.stringify(candidate)).not.toContain("inputs.github_token");
    }
  });

  it("tells Factory how the review ended, or that there was none", () => {
    expect(begin.env?.RISK_REVIEW_OUTCOME).toBe(
      "${{ github.action_status == 'success' && steps.prepare.outputs.contains_trigger != 'true' && 'skipped' || github.action_status }}",
    );
  });

  it("runs every script from a copy frozen before the review, never from the checkout or PATH", () => {
    for (const [id, kind] of [
      ["risk_begin", "risk_begin"],
      ["risk_token", "risk_token"],
      ["risk_assess", "risk_assess"],
      ["risk_settle", "settle"],
    ] as const) {
      const candidate = risk.find((found) => found.id === id);
      expect(candidate?.env).toMatchObject({
        TRUSTED_TAIL_PATH: `\${{ steps.prepare.outputs.review_${kind}_publisher_path }}`,
        TRUSTED_TAIL_SHA256: `\${{ steps.prepare.outputs.review_${kind}_publisher_sha256 }}`,
        TRUSTED_RUNTIME_PATH:
          "${{ steps.prepare.outputs.review_runtime_path }}",
        TRUSTED_RUNTIME_SHA256:
          "${{ steps.prepare.outputs.review_runtime_sha256 }}",
      });
      expect(candidate?.run).toContain(
        '"$TRUSTED_RUNTIME_PATH" --config=/dev/null --env-file=/dev/null run "$TRUSTED_TAIL_PATH"',
      );
    }
    for (const candidate of risk) {
      expect(candidate.run).not.toContain("GITHUB_ACTION_PATH");
      expect(candidate.run).not.toContain("github.action_path");
      expect(candidate.run).not.toMatch(/(^|\s)bun\s/);
    }
  });

  it("assesses the pull request a comment was left on", () => {
    expect(begin.env?.RISK_PR_NUMBER).toBe(
      "${{ inputs.risk_pr_number || (github.event.issue.pull_request && github.event.issue.number) || '' }}",
    );
  });

  it("installs its own Droid CLI instead of reusing the review's", () => {
    const install = risk.find(
      (candidate) => candidate.name === "Install Droid CLI for the risk judge",
    );
    expect(install?.run).toContain("https://app.factory.ai/cli");
    expect(JSON.stringify(risk)).not.toContain("path_to_droid_executable");
  });

  // test/risk-tail-runtime.test.ts runs the standalone action's tail scripts
  // against real files; identical scripts here inherit that coverage.
  it("runs the same scripts after the judge as the standalone risk action", () => {
    const standalone = load("risk/action.yml");
    const pairs: Array<[string, string]> = [
      ["Revoke judge read token", "Revoke judge read token"],
      ["Report risk result to Factory", "Report to Factory"],
    ];
    for (const [rootName, standaloneName] of pairs) {
      const mine = risk.find((candidate) => candidate.name === rootName);
      const theirs = standalone.find(
        (candidate) => candidate.name === standaloneName,
      );
      if (!mine?.run || !theirs?.run) {
        throw new Error(`${rootName} is missing from one of the actions`);
      }
      expect(mine.run).toBe(theirs.run);
    }
  });
});
