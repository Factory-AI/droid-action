import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

const root = join(import.meta.dir, "..");
const loadAction = (relativePath: string): any =>
  parse(readFileSync(join(root, relativePath), "utf8"));

const stepById = (action: any, id: string): any =>
  action.runs.steps.find((step: any) => step.id === id);
const stepByName = (action: any, name: string): any =>
  action.runs.steps.find((step: any) => step.name === name);

const ACTIONS = ["action.yml", "review/action.yml", "security/action.yml"];
const STANDALONE = [
  ["review/action.yml", "code"],
  ["security/action.yml", "security"],
] as const;
/** When the full action runs a review. */
const REVIEW_RUNS =
  "steps.prepare.outputs.contains_trigger == 'true' && steps.prepare.outputs.steward_skipped != 'true' && steps.prepare.outputs.command_mode == '' && steps.prepare.outputs.run_code_review == 'true'";
/** When a standalone action runs one. */
const NOT_SKIPPED = "steps.prepare.outputs.review_skipped != 'true'";
const ANSWERED_AND_POSTED =
  "${{ steps.review.outputs.conclusion == 'success' && steps.post_review.outputs.conclusion == 'success' }}";
const REVIEW_ERROR = "${{ steps.review.outputs.error_message || '' }}";

describe("review safety wiring", () => {
  for (const relativePath of ["action.yml", "prepare/action.yml"]) {
    it(`forwards the security choice to preparation in ${relativePath}`, () => {
      const action = loadAction(relativePath);

      expect(stepById(action, "prepare").env.AUTOMATIC_SECURITY_REVIEW).toBe(
        "${{ inputs.automatic_security_review }}",
      );
    });
  }

  it("uses the actual security result when updating the final comment", () => {
    const action = loadAction("action.yml");
    const updateComment = action.runs.steps.find(
      (step: any) => step.name === "Update comment with job link",
    );

    expect(updateComment.env.AUTOMATIC_SECURITY_REVIEW).toBe(
      "${{ steps.prepare.outputs.run_security_review }}",
    );
  });

  it("publishes what the review step answered, and keeps the base runner out of a review, in the main action", () => {
    const action = loadAction("action.yml");

    expect(stepById(action, "droid").if).toContain(
      "steps.prepare.outputs.run_code_review != 'true'",
    );
    for (const step of [
      stepByName(action, "Review lifecycle reviewing"),
      stepById(action, "review"),
    ]) {
      expect(step.if).toBe(REVIEW_RUNS);
    }
    expect(stepById(action, "post_review").if).toContain(
      "steps.review.outputs.conclusion == 'success'",
    );
    expect(stepById(action, "post_review").run).toContain(
      '"$REVIEW_PUBLISHER_PATH"',
    );
    expect(stepById(action, "post_review").env.REVIEW_PUBLISHER_PATH).toBe(
      "${{ steps.prepare.outputs.review_post_publisher_path }}",
    );
  });

  it.each(STANDALONE)(
    "publishes what the review step answered, and runs nothing of a skipped review, in %s",
    (relativePath, type) => {
      const action = loadAction(relativePath);
      const download = stepByName(action, "Download the worker");

      expect(stepById(action, "prepare").env.REVIEW_TYPE).toBe(type);
      for (const step of [
        download,
        stepByName(action, "Review lifecycle reviewing"),
        stepById(action, "review"),
      ]) {
        expect(step.if).toBe(NOT_SKIPPED);
      }
      expect(stepById(action, "post_review").if).toBe(
        `${NOT_SKIPPED} && steps.review.outputs.conclusion == 'success'`,
      );
      expect(stepById(action, "post_review").run).toContain(
        '"$REVIEW_PUBLISHER_PATH"',
      );
      expect(stepById(action, "post_review").env.REVIEW_PUBLISHER_PATH).toBe(
        "${{ steps.prepare.outputs.review_post_publisher_path }}",
      );
      expect(action.outputs.conclusion.value).toBe(
        "${{ steps.post_review.outputs.conclusion || steps.review.outputs.conclusion }}",
      );
      expect(action.inputs.worker_token.required).toBe(true);
    },
  );

  // The full action's review step is the one whose shell a test runs.
  it.each(STANDALONE.map(([relativePath]) => relativePath))(
    "runs the full action's review step in %s",
    (relativePath) => {
      const { shell, run, env } = stepById(loadAction(relativePath), "review");

      expect({ shell, run, env }).toEqual({
        shell: stepById(loadAction("action.yml"), "review").shell,
        run: stepById(loadAction("action.yml"), "review").run,
        env: stepById(loadAction("action.yml"), "review").env,
      });
    },
  );

  it.each(ACTIONS)(
    "has the review step answer about the commits, and where, the post step publishes from in %s",
    (relativePath) => {
      const action = loadAction(relativePath);

      for (const name of [
        "REVIEW_HEAD_SHA",
        "REVIEW_BASE_SHA",
        "REVIEW_SECURITY_ONLY",
        "REVIEW_VALIDATED_PATH",
      ]) {
        expect(stepById(action, "review").env[name]).toBeDefined();
        expect(stepById(action, "review").env[name]).toBe(
          stepById(action, "post_review").env[name],
        );
      }
    },
  );

  it.each([
    [
      "action.yml",
      "Update comment with job link",
      "${{ (steps.prepare.outputs.run_code_review == 'true' && steps.review.outputs.conclusion == 'success' && steps.post_review.outputs.conclusion == 'success') || (steps.prepare.outputs.run_code_review != 'true' && steps.droid.outputs.conclusion == 'success') }}",
      "${{ steps.review.outputs.error_message || steps.droid.outputs.error_message || '' }}",
      "${{ steps.prepare.outputs.model_fallback_note || steps.review.outputs.model_fallback_note || steps.droid.outputs.model_fallback_note || '' }}",
    ],
    ...STANDALONE.map(([relativePath]) => [
      relativePath,
      "Update tracking comment",
      ANSWERED_AND_POSTED,
      REVIEW_ERROR,
      "${{ steps.review.outputs.model_fallback_note || '' }}",
    ]),
  ])(
    "calls a review a success only when it answered and was posted, and says why it was not, in %s",
    (relativePath, trackingName, success, error, note) => {
      const action = loadAction(relativePath);
      const tracking = stepByName(action, trackingName);
      const finalize = stepByName(action, "Review lifecycle finalize");

      expect(tracking.env).toMatchObject({
        DROID_SUCCESS: success,
        DROID_ERROR_MESSAGE: error,
        MODEL_FALLBACK_NOTE: note,
      });
      expect(finalize.env).toMatchObject({
        DROID_SUCCESS: ANSWERED_AND_POSTED,
        DROID_ERROR_MESSAGE: REVIEW_ERROR,
      });
    },
  );

  // Both passes of a review run pull request code, so the step that starts
  // them is never given a GitHub credential or the token the worker was
  // downloaded with; only the deterministic post step holds one.
  for (const relativePath of ACTIONS) {
    it(`gives the review step no GitHub or download token in ${relativePath}`, () => {
      const action = loadAction(relativePath);
      const review = stepById(action, "review");

      expect(JSON.stringify([review.env, review.run])).not.toMatch(
        /GITHUB_TOKEN|GH_TOKEN|WORKER_TOKEN|github\.token|inputs\.github_token/,
      );
      expect(stepById(action, "post_review").env.GITHUB_TOKEN).toBeDefined();
    });
  }

  // `toJson(inputs)` holds the worker token whatever the step names.
  it.each(ACTIONS)(
    "gives the worker token only to steps that end before the review starts in %s",
    (relativePath) => {
      const action = loadAction(relativePath);
      const steps: any[] = action.runs.steps;
      const download = stepByName(action, "Download the worker");
      const review = stepById(action, "review");
      const holders = steps.filter((step) =>
        /worker_token|toJson\(\s*inputs/i.test(JSON.stringify(step)),
      );

      expect(holders).toEqual([stepById(action, "prepare"), download]);
      expect(steps.indexOf(download)).toBeLessThan(steps.indexOf(review));
      expect(download.env.WORKER_TOKEN).toBe("${{ inputs.worker_token }}");
      expect(download.env.WORKER_DIR).toBe(review.env.WORKER_DIR);
      expect(download.shell).toBe(review.shell);
      expect(download.run).toBe(
        `bun --config=/dev/null --env-file=/dev/null run ${
          relativePath === "action.yml"
            ? "${GITHUB_ACTION_PATH}"
            : "${{ github.action_path }}/.."
        }/src/entrypoints/worker-download.ts\n`,
      );
    },
  );

  it("downloads the worker for a risk assessment or a review, and for nothing else, in the main action", () => {
    expect(stepByName(loadAction("action.yml"), "Download the worker").if).toBe(
      `\${{ !cancelled() && (inputs.risk_assessment == 'true' || (${REVIEW_RUNS})) }}`,
    );
  });

  it.each(ACTIONS)("reads only steps it has in %s", (relativePath) => {
    const action = loadAction(relativePath);
    const ids = new Set(action.runs.steps.map((step: any) => step.id));
    const read = [
      ...JSON.stringify(action).matchAll(
        /steps\.([\w-]+)\.(?:outputs|outcome|conclusion)\b/g,
      ),
    ].map((match) => match[1]);

    expect(read).toContain("review");
    expect(read.filter((id) => !ids.has(id))).toEqual([]);
  });

  it("exposes max_turns through the reusable base action", () => {
    const action = loadAction("base-action/action.yml");

    expect(action.inputs.max_turns).toBeDefined();
    expect(stepById(action, "run_droid").env.INPUT_MAX_TURNS).toContain(
      "max_turns",
    );
  });
});
