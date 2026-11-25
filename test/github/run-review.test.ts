import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { tempDir } from "../azure-devops/helpers";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(REPO_ROOT, "github/run-review.sh");
const HEAD = "a".repeat(40);
const WRITE_TOKEN = "ghs_write_token";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Stub `bun` (entrypoints) and `droid` binaries record how run-review.sh
 * drives them, so both parts are tested without network or models. The
 * entrypoint stubs report outputs the way @actions/core does.
 */
const BUN_STUB = `#!/usr/bin/env bash
echo "bun $*" >> "$STUB_LOG"
out() { printf '%s<<EOF\\n%s\\nEOF\\n' "$1" "$2" >> "$GITHUB_OUTPUT"; }
case "$*" in
  *github-pr-event.ts)
    echo '{}' > "$GITHUB_EVENT_PATH"
    out head_sha "\${STUB_HEAD:-$PR_HEAD_SHA}"
    out author octocat
    ;;
  *prepare.ts)
    echo "prepare actor=$GITHUB_ACTOR auto=$AUTOMATIC_REVIEW config=[\${REVIEW_CONFIG_JSON-unset}] override=$OVERRIDE_GITHUB_TOKEN cwd=$PWD" >> "$STUB_LOG"
    echo "::add-mask::$OVERRIDE_GITHUB_TOKEN"
    out github_token "$OVERRIDE_GITHUB_TOKEN"
    out mcp_tools "{\\"env\\":{\\"GITHUB_TOKEN\\":\\"$OVERRIDE_GITHUB_TOKEN\\"}}"
    out review_head_sha "\${STUB_REVIEW_HEAD-$PR_HEAD_SHA}"
    out review_check_id 11
    out review_comment_id 22
    out droid_comment_id 22
    out droid_exec_run_type droid-review
    out review_config_json '{"review_depth":"shallow"}'
    out review_model openai-latest-fast
    out review_reasoning_effort default
    out run_code_review "\${STUB_RUN_CODE_REVIEW:-true}"
    printf 'REVIEW_DEPTH<<EOF\\nshallow\\nEOF\\n' >> "$GITHUB_ENV"
    mkdir -p "$RUNNER_TEMP/droid-prompts"
    echo "candidates prompt" > "$RUNNER_TEMP/droid-prompts/droid-prompt.txt"
    if [ -n "\${STUB_PREPARE_ERROR:-}" ]; then out prepare_error "$STUB_PREPARE_ERROR"; exit 1; fi
    ;;
  *github-review-lifecycle.ts)
    echo "lifecycle phase=$REVIEW_PHASE check=$REVIEW_CHECK_ID head=$REVIEW_HEAD_SHA success=\${DROID_SUCCESS-unset} error=\${DROID_POST_ERROR_MESSAGE:-}\${DROID_VALIDATOR_ERROR_MESSAGE:-}\${DROID_ERROR_MESSAGE:-}\${PREPARE_ERROR:-}" >> "$STUB_LOG"
    ;;
  *prepare-validator.ts)
    echo "validator-prompt effort=[$REASONING_EFFORT] depth=$REVIEW_DEPTH model=$REVIEW_MODEL comment=$DROID_COMMENT_ID token=$GITHUB_TOKEN" >> "$STUB_LOG"
    if [ "\${STUB_CANDIDATES:-valid}" = invalid ]; then out validator_should_run false; exit 0; fi
    out validator_should_run true
    out droid_args '--enabled-tools "Read"'
    out mcp_tools '{"mcpServers":{}}'
    ;;
  *base-action/src/index.ts)
    echo "validator github_token=\${GITHUB_TOKEN-unset} gh_token=\${GH_TOKEN-unset} factory=\${FACTORY_API_KEY-unset} args=$INPUT_DROID_ARGS mcp=$INPUT_MCP_TOOLS turns=$INPUT_MAX_TURNS prompt=$INPUT_PROMPT_FILE" >> "$STUB_LOG"
    if [ -n "\${STUB_VALIDATOR_ERROR:-}" ]; then out error_message "$STUB_VALIDATOR_ERROR"; exit 1; fi
    ;;
  *github-post-review.ts)
    echo "post token=$GITHUB_TOKEN effort=[$REASONING_EFFORT] check=$REVIEW_CHECK_ID bun_options=\${BUN_OPTIONS-unset}" >> "$STUB_LOG"
    if [ -n "\${STUB_POST_ERROR:-}" ]; then out error_message "$STUB_POST_ERROR"; exit 1; fi
    ;;
esac
exit 0
`;

const DROID_STUB = `#!/usr/bin/env bash
echo "droid $*" >> "$STUB_LOG"
`;

/** One machine: both parts of a run share its RUNNER_TEMP and HOME. */
function machine() {
  const root = tempDir("gh-run-");
  dirs.push(root);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "bun"), BUN_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "droid"), DROID_STUB, { mode: 0o755 });
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout);
  const runnerTemp = path.join(root, "runner-temp");
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(tmp);
  const log = path.join(root, "calls.log");
  const stateFile = path.join(runnerTemp, "droid-prompts/github-review-state");

  const run = (part: "before" | "after", env: Record<string, string> = {}) => {
    fs.writeFileSync(log, "");
    const result = spawnSync("bash", [SCRIPT, part], {
      encoding: "utf8",
      cwd: checkout,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: home,
        TMPDIR: tmp,
        RUNNER_TEMP: runnerTemp,
        STUB_LOG: log,
        GITHUB_REPOSITORY: "acme/app",
        PR_NUMBER: "7",
        PR_HEAD_SHA: HEAD,
        PR_ACTION: "synchronize",
        GITHUB_TOKEN: WRITE_TOKEN,
        GITHUB_RUN_ID: "run-1",
        GH_TOKEN: "ghu_read_token",
        FACTORY_API_KEY: "fk-123",
        ...env,
      },
    });
    const calls = fs.readFileSync(log, "utf8");
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls,
      entrypoints: calls
        .split("\n")
        .filter((l) => l.startsWith("bun "))
        .map((l) => l.replace(`${REPO_ROOT}/`, "")),
    };
  };
  return { run, checkout, runnerTemp, home, tmp, stateFile };
}

function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("github/run-review.sh before", () => {
  it("prepares the review without leaving the token in the log or on disk", () => {
    const m = machine();
    const run = m.run("before");
    expect(run.status).toBe(0);
    expect(run.entrypoints).toEqual([
      "bun install --frozen-lockfile",
      "bun --config=/dev/null --env-file=/dev/null run src/entrypoints/github-pr-event.ts",
      "bun --config=/dev/null --env-file=/dev/null run src/entrypoints/prepare.ts",
      "bun --config=/dev/null --env-file=/dev/null run src/entrypoints/github-review-lifecycle.ts",
    ]);
    // Entrypoints run from the PR checkout, as in action.yml, with the PR
    // author as actor and no review configuration carried in.
    expect(run.calls).toContain(
      `prepare actor=octocat auto=true config=[] override=${WRITE_TOKEN} cwd=${m.checkout}`,
    );
    expect(run.calls).toContain(
      `lifecycle phase=candidates check=11 head=${HEAD}`,
    );

    // The session can read these; the outputs holding the token are deleted.
    expect(run.stdout + run.stderr).not.toContain(WRITE_TOKEN);
    expect(fs.readdirSync(m.tmp)).toEqual([]);
    const readable = [...filesUnder(m.runnerTemp), ...filesUnder(m.home)];
    expect(readable.length).toBeGreaterThan(0);
    for (const file of readable)
      expect(fs.readFileSync(file, "utf8")).not.toContain(WRITE_TOKEN);
    const state = fs.readFileSync(m.stateFile, "utf8");
    expect(state).toContain("REVIEW_CHECK_ID=11\n");
    expect(state).toContain('REVIEW_CONFIG_JSON={"review_depth":"shallow"}\n');
    expect(state).toContain("REVIEW_DEPTH=shallow\n");
    expect(
      fs.existsSync(path.join(m.home, ".factory/droids/security-reviewer.md")),
    ).toBe(true);
  });

  it("skips without touching GitHub when the PR moved past PR_HEAD_SHA", () => {
    const m = machine();
    const run = m.run("before", { STUB_HEAD: "b".repeat(40) });
    expect(run.status).toBe(0);
    expect(run.calls).not.toContain("prepare.ts");
    expect(run.stdout).toContain("Nothing was posted to the pull request");
    expect(fs.existsSync(m.stateFile)).toBe(false);
  });

  it("stops after prepare when there is no review to run", () => {
    const m = machine();
    const run = m.run("before", { STUB_RUN_CODE_REVIEW: "false" });
    expect(run.status).toBe(0);
    expect(run.calls).not.toContain("lifecycle");
    expect(fs.existsSync(m.stateFile)).toBe(false);
  });

  const MOVED = "c".repeat(40);
  it.each([
    [
      { STUB_PREPARE_ERROR: "gh pr checkout failed" },
      HEAD,
      "gh pr checkout failed",
    ],
    [
      { STUB_REVIEW_HEAD: MOVED },
      MOVED,
      `PR #7 moved to ${MOVED} while Droid prepared the review of ${HEAD}.`,
    ],
  ])(
    "closes the check it opened when preparing fails (%p)",
    (env, head, error) => {
      const m = machine();
      const run = m.run("before", env);
      expect(run.status).toBe(1);
      expect(run.calls).toContain(
        `lifecycle phase=finalize check=11 head=${head} success=false error=${error}`,
      );
      expect(fs.existsSync(m.stateFile)).toBe(false);
    },
  );

  it("leaves GitHub alone when prepare fails before opening a check", () => {
    const m = machine();
    const run = m.run("before", {
      STUB_PREPARE_ERROR: "Actor does not have write permissions",
      STUB_REVIEW_HEAD: "",
    });
    expect(run.status).toBe(1);
    expect(run.calls).not.toContain("lifecycle");
  });

  it.each([
    ["before", "GITHUB_RUN_ID"],
    ["after", "FACTORY_API_KEY"],
  ] as const)("%s fails before doing anything without %s", (part, name) => {
    const m = machine();
    const run = m.run(part, { [name]: "" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(name);
    expect(run.entrypoints).toEqual([]);
  });
});

describe("github/run-review.sh after", () => {
  it("validates without GitHub credentials, then posts with the token", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    const run = m.run("after");
    expect(run.status).toBe(0);
    expect(run.entrypoints).toEqual([
      "bun install --frozen-lockfile",
      "bun --config=/dev/null --env-file=/dev/null run src/entrypoints/github-pr-event.ts",
      "bun --config=/dev/null --env-file=/dev/null run src/entrypoints/github-review-lifecycle.ts",
      "bun --config=/dev/null --env-file=/dev/null run src/entrypoints/prepare-validator.ts",
      "bun --config=/dev/null --env-file=/dev/null run base-action/src/index.ts",
      "bun --config=/dev/null --env-file=/dev/null run src/entrypoints/github-review-lifecycle.ts",
      "bun --config=/dev/null --env-file=/dev/null run src/entrypoints/github-post-review.ts",
    ]);
    expect(run.calls).toContain(
      `lifecycle phase=validated check=11 head=${HEAD}`,
    );
    // The validator prompt gets prepare's model and depth, and no effort for
    // the "default" label, as action.yml passes them.
    expect(run.calls).toContain(
      `validator-prompt effort=[] depth=shallow model=openai-latest-fast comment=22 token=${WRITE_TOKEN}`,
    );
    expect(run.calls).toContain(
      `validator github_token=unset gh_token=unset factory=fk-123 args=--enabled-tools "Read" mcp={"mcpServers":{}} turns=40 prompt=${m.runnerTemp}/droid-prompts/droid-prompt.txt`,
    );
    expect(run.calls).toContain(`lifecycle phase=posted check=11 head=${HEAD}`);
    expect(run.calls).toContain(
      `post token=${WRITE_TOKEN} effort=[default] check=11`,
    );
    expect(run.calls).not.toContain("phase=finalize");
  });

  it("does nothing when before prepared no review", () => {
    const m = machine();
    const run = m.run("after");
    expect(run.status).toBe(0);
    expect(run.entrypoints).toEqual([]);
    expect(run.stdout).toContain("nothing to post");
  });

  it.each([
    [
      { STUB_CANDIDATES: "invalid" },
      "The review session did not write valid candidates to",
      "base-action/src/index.ts",
    ],
    [
      { STUB_VALIDATOR_ERROR: "turn cap reached" },
      "turn cap reached",
      "github-post-review.ts",
    ],
    [{ STUB_POST_ERROR: "422 Unprocessable" }, "422 Unprocessable", undefined],
  ])("closes the check with the failure (%p)", (env, error, skipped) => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    const run = m.run("after", env);
    expect(run.status).toBe(1);
    expect(run.calls).toContain(
      `lifecycle phase=finalize check=11 head=${HEAD} success=false error=${error}`,
    );
    if (skipped) expect(run.calls).not.toContain(skipped);
  });

  it("refuses a prepared review for a different commit", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    const run = m.run("after", { PR_HEAD_SHA: "d".repeat(40) });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("nothing was posted");
    expect(run.entrypoints).toEqual([]);
  });

  it("sets only the allowlisted values from the state file", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    fs.appendFileSync(m.stateFile, "BUN_OPTIONS=--preload=/tmp/evil.ts\n");
    const run = m.run("after");
    expect(run.status).toBe(0);
    expect(run.calls).toContain("bun_options=unset");
  });
});
