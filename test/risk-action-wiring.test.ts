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
const rootRiskEnd =
  rootSteps.findIndex((candidate) => candidate.id === "risk_settle") + 1;

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
    steps: rootSteps.slice(rootRiskStart, rootRiskEnd),
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
  const risk = rootSteps.slice(rootRiskStart, rootRiskEnd);
  const begin = risk[0]!;
  const prepareStep = before.find((candidate) => candidate.id === "prepare")!;
  // What prepare reads to decide whether this run reviews, assesses, or both.
  const PLAN_INPUTS = {
    RISK_STEPS_AVAILABLE: "true",
    AUTOMATIC_RISK_ASSESSMENT: "${{ inputs.automatic_risk_assessment }}",
    RISK_ASSESSMENT: "${{ inputs.risk_assessment }}",
    RUN_MODE: "${{ inputs.run }}",
    RISK_PR_NUMBER: "${{ inputs.risk_pr_number }}",
    RISK_DRY_RUN: "${{ inputs.risk_dry_run }}",
  };

  it("runs only when prepare's run plan asks for an assessment", () => {
    expect(rootRiskStart).toBeGreaterThan(0);
    expect(begin.if).toBe(
      "${{ !cancelled() && steps.prepare.outputs.run_risk == 'true' }}",
    );
    expect(JSON.stringify(risk)).not.toContain("inputs.risk_assessment");
    expect(JSON.stringify(risk)).not.toContain(
      "inputs.automatic_risk_assessment",
    );
  });

  it("tells prepare what decides the plan, and no review step anything else of the risk inputs", () => {
    expect(prepareStep.env).toMatchObject(PLAN_INPUTS);
    for (const candidate of before) {
      let text = JSON.stringify(candidate);
      if (candidate === prepareStep)
        for (const expression of Object.values(PLAN_INPUTS))
          text = text.replace(expression, "");
      expect(text).not.toContain("inputs.risk_");
      expect(text).not.toContain("inputs.automatic_risk_assessment");
      expect(text).not.toContain("inputs.run ");
    }
  });

  // run_review: off exits prepare with contains_trigger=false, which every
  // review step already skips on, so no review step reads the plan.
  it("is the only prepare step that has risk steps to plan for", () => {
    const subAction = load("prepare/action.yml").find((candidate) =>
      candidate.run?.includes("src/entrypoints/prepare.ts"),
    );
    expect(subAction).toBeDefined();
    expect(subAction?.env?.RISK_STEPS_AVAILABLE).toBeUndefined();
  });

  it("leaves every review step gated on prepare's existing outputs only", () => {
    const gated = before.filter((candidate) => candidate.if);
    expect(gated.length).toBeGreaterThan(0);
    for (const candidate of gated) {
      for (const output of [
        "run_review",
        "run_risk",
        "risk_manual",
        "run_reason",
      ])
        expect(candidate.if).not.toContain(`steps.prepare.outputs.${output}`);
    }
  });

  it("asks for a manual assessment when the plan or the caller says so", () => {
    expect(begin.env?.RISK_MANUAL).toBe(
      "${{ steps.prepare.outputs.risk_manual == 'true' || inputs.risk_manual == 'true' }}",
    );
  });

  // A missing id-token: write skips the assessment in prepare; it must not
  // turn the review's job red.
  it("ends with the report step, and has no step that fails the job when the assessment is skipped", () => {
    expect(rootSteps.at(-1)?.id).toBe("risk_settle");
    expect(rootSteps.length).toBe(rootRiskEnd);
    for (const candidate of rootSteps)
      expect(JSON.stringify(candidate)).not.toContain("risk_setup_error");
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
      "${{ (steps.prepare.outputs.run_review == 'off' || steps.prepare.outputs.contains_trigger != 'true' || steps.prepare.outputs.steward_skipped == 'true') && github.action_status == 'success' && 'skipped' || github.action_status }}",
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

// A workflow that runs the review and the assessment as two steps hands
// what the review read from one to the other.
describe("what the review read, passed between two steps", () => {
  type Declared = {
    inputs?: Record<string, { required?: boolean; default?: string }>;
    outputs?: Record<string, { value?: string }>;
  };
  const declared = (relativePath: string): Declared =>
    parse(readFileSync(join(import.meta.dir, "..", relativePath), "utf8"));
  const root = declared("action.yml");
  const standalone = declared("risk/action.yml");

  it.each([
    ["review_base_sha", "RISK_REVIEW_BASE_SHA"],
    ["review_has_rules", "RISK_REVIEW_HAS_RULES"],
  ])(
    "leaves the full action as %s and reaches the standalone begin step as %s",
    (name, variable) => {
      const fromPrepare = `\${{ steps.prepare.outputs.${name} }}`;
      expect(root.outputs?.[name]?.value).toBe(fromPrepare);
      // The bundled assessment is told the same thing the output says.
      expect(rootSteps[rootRiskStart]?.env?.[variable]).toBe(fromPrepare);

      expect(standalone.inputs?.[name]).toMatchObject({
        required: false,
        default: "",
      });
      const begin = load("risk/action.yml").find(
        (candidate) => candidate.id === "begin",
      );
      expect(begin?.env?.[variable]).toBe(`\${{ inputs.${name} }}`);
    },
  );
});

describe("inputs that choose what runs", () => {
  const inputs: Record<
    string,
    { description?: string; required?: boolean; default?: string }
  > = parse(
    readFileSync(join(import.meta.dir, "..", "action.yml"), "utf8"),
  ).inputs;

  it("declares automatic_risk_assessment and run with review-only defaults", () => {
    expect(inputs.automatic_risk_assessment).toMatchObject({
      required: false,
      default: "false",
    });
    expect(inputs.run).toMatchObject({ required: false, default: "auto" });
  });

  // An empty default is how prepare tells an unset alias from an explicit one.
  it("keeps risk_assessment as a deprecated alias that defaults to unset", () => {
    expect(inputs.risk_assessment).toMatchObject({
      required: false,
      default: "",
    });
    expect(inputs.risk_assessment?.description).toMatch(/^Deprecated/);
    expect(inputs.risk_assessment?.description).toContain(
      "automatic_risk_assessment",
    );
  });
});
