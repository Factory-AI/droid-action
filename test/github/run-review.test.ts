import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { tempDir } from "../azure-devops/helpers";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(REPO_ROOT, "github/run-review.sh");
const HEAD = "a".repeat(40);
const WRITE_TOKEN = "ghs_write_token";
const READ_TOKEN = "ghs_read_token";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Stub `bun` (entrypoints) and `droid` binaries record how run-review.sh
 * drives them, so every part is tested without network or models. The
 * entrypoint stubs report outputs the way @actions/core does. The validator
 * runs with a cleared environment, so the stub reads its settings from
 * stub.env and records the environment the validator received.
 */
const BUN_STUB = `#!/usr/bin/env bash
received_env="$(env)"
. "__STUB_DIR__/stub.env"
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
    echo "lifecycle phase=$REVIEW_PHASE check=$REVIEW_CHECK_ID head=$REVIEW_HEAD_SHA success=\${DROID_SUCCESS-unset} error=\${DROID_POST_ERROR_MESSAGE:-}\${DROID_VALIDATOR_ERROR_MESSAGE:-}\${PREPARE_ERROR:-}" >> "$STUB_LOG"
    ;;
  *prepare-validator.ts)
    echo "validator-prompt effort=[$REASONING_EFFORT] depth=$REVIEW_DEPTH model=$REVIEW_MODEL comment=$DROID_COMMENT_ID token=$GITHUB_TOKEN" >> "$STUB_LOG"
    if [ "\${STUB_CANDIDATES:-valid}" = invalid ]; then out validator_should_run false; exit 0; fi
    out validator_should_run true
    out droid_args '--enabled-tools "Read"'
    out mcp_tools '{"mcpServers":{}}'
    ;;
  *base-action/src/index.ts)
    printf '%s\\n' "$received_env" > "__STUB_DIR__/validator.env"
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

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** One machine: every part of a run shares its RUNNER_TEMP and HOME. */
function machine() {
  const root = tempDir("gh-run-");
  dirs.push(root);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "bun"),
    BUN_STUB.replaceAll("__STUB_DIR__", root),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "droid"), DROID_STUB, { mode: 0o755 });
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout);
  spawnSync("git", ["init", "-q", checkout]);
  const runnerTemp = path.join(root, "runner-temp");
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(tmp);
  const log = path.join(root, "calls.log");
  const validatorEnvFile = path.join(root, "validator.env");
  const prompts = path.join(runnerTemp, "droid-prompts");
  const stateFile = path.join(prompts, "github-review-state");
  const errorFile = path.join(prompts, "github-review-error");

  const run = (
    part: "before" | "validate" | "after",
    env: Record<string, string> = {},
  ) => {
    fs.writeFileSync(log, "");
    fs.rmSync(validatorEnvFile, { force: true });
    fs.writeFileSync(
      path.join(root, "stub.env"),
      Object.entries({ STUB_LOG: log, ...env })
        .filter(([name]) => name.startsWith("STUB_"))
        .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
        .join(""),
    );
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
        GITHUB_TOKEN: part === "validate" ? READ_TOKEN : WRITE_TOKEN,
        GITHUB_RUN_ID: "run-1",
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
        .map((l) =>
          l.replace(
            `bun --config=/dev/null --env-file=/dev/null run ${REPO_ROOT}/`,
            "",
          ),
        ),
      validatorEnv: fs.existsSync(validatorEnvFile)
        ? Object.fromEntries(
            fs
              .readFileSync(validatorEnvFile, "utf8")
              .trim()
              .split("\n")
              .map((line) => [
                line.slice(0, line.indexOf("=")),
                line.slice(line.indexOf("=") + 1),
              ]),
          )
        : undefined,
    };
  };
  return { run, checkout, runnerTemp, home, tmp, stateFile, errorFile };
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
      "src/entrypoints/github-pr-event.ts",
      "src/entrypoints/prepare.ts",
      "src/entrypoints/github-review-lifecycle.ts",
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
    const readable = [
      ...filesUnder(m.runnerTemp),
      ...filesUnder(m.home),
      ...filesUnder(path.join(m.checkout, ".git")),
    ];
    expect(readable).toContain(m.stateFile);
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

  it("tells the caller to skip the session when the PR moved past PR_HEAD_SHA", () => {
    const m = machine();
    const run = m.run("before", { STUB_HEAD: "b".repeat(40) });
    expect(run.status).toBe(78);
    expect(run.calls).not.toContain("prepare.ts");
    expect(run.stdout).toContain("Nothing was posted to the pull request");
    expect(fs.existsSync(m.stateFile)).toBe(false);
  });

  it("tells the caller to skip the session when there is no review to run", () => {
    const m = machine();
    const run = m.run("before", { STUB_RUN_CODE_REVIEW: "false" });
    expect(run.status).toBe(78);
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
    ["validate", "FACTORY_API_KEY"],
  ] as const)("%s fails before doing anything without %s", (part, name) => {
    const m = machine();
    const run = m.run(part, { [name]: "" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(name);
    expect(run.entrypoints).toEqual([]);
  });
});

describe("github/run-review.sh validate", () => {
  it("runs the validator with no GitHub credential and leaves the check alone", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    const run = m.run("validate", {
      GH_TOKEN: "ghu_machine_token",
      OVERRIDE_GITHUB_TOKEN: WRITE_TOKEN,
      CALLER_SETTING: "kept out",
    });
    expect(run.status).toBe(0);
    expect(run.entrypoints).toEqual([
      "bun install --frozen-lockfile",
      "src/entrypoints/github-pr-event.ts",
      "src/entrypoints/prepare-validator.ts",
      "base-action/src/index.ts",
    ]);
    // The validator prompt gets prepare's model and depth, and no effort for
    // the "default" label, as action.yml passes them.
    expect(run.calls).toContain(
      `validator-prompt effort=[] depth=shallow model=openai-latest-fast comment=22 token=${READ_TOKEN}`,
    );
    const { PWD, SHLVL, _, ...validatorEnv } = run.validatorEnv!;
    expect(validatorEnv).toEqual({
      PATH: expect.any(String),
      HOME: m.home,
      FACTORY_API_KEY: "fk-123",
      DROID_EXEC_RUN_TYPE: "droid-review",
      FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
      DETAILED_PERMISSION_MESSAGES: "1",
      INPUT_MAX_TURNS: "40",
      INPUT_PROMPT_FILE: path.join(
        m.runnerTemp,
        "droid-prompts/droid-prompt.txt",
      ),
      INPUT_DROID_ARGS: '--enabled-tools "Read"',
      INPUT_MCP_TOOLS: '{"mcpServers":{}}',
      GITHUB_OUTPUT: expect.any(String),
    });
    expect(run.calls).not.toContain("lifecycle");
    expect(fs.existsSync(m.errorFile)).toBe(false);
  });

  it.each([
    [
      { STUB_CANDIDATES: "invalid" },
      "The review session did not write valid candidates to",
    ],
    [{ STUB_VALIDATOR_ERROR: "turn cap reached" }, "turn cap reached"],
  ])("leaves its failure for after to report (%p)", (env, error) => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    const run = m.run("validate", env);
    expect(run.status).toBe(1);
    expect(fs.readFileSync(m.errorFile, "utf8")).toContain(error);
    expect(run.calls).not.toContain("lifecycle");
  });

  it("clears an earlier failure when a retry succeeds", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    expect(m.run("validate", { STUB_VALIDATOR_ERROR: "timeout" }).status).toBe(
      1,
    );
    expect(m.run("validate").status).toBe(0);
    expect(fs.existsSync(m.errorFile)).toBe(false);
  });
});

describe("github/run-review.sh after", () => {
  it("posts the review with the token and closes the check", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    expect(m.run("validate").status).toBe(0);
    const run = m.run("after");
    expect(run.status).toBe(0);
    expect(run.entrypoints).toEqual([
      "bun install --frozen-lockfile",
      "src/entrypoints/github-pr-event.ts",
      "src/entrypoints/github-review-lifecycle.ts",
      "src/entrypoints/github-review-lifecycle.ts",
      "src/entrypoints/github-post-review.ts",
    ]);
    expect(run.calls).toContain(
      `lifecycle phase=validated check=11 head=${HEAD}`,
    );
    expect(run.calls).toContain(`lifecycle phase=posted check=11 head=${HEAD}`);
    expect(run.calls).toContain(
      `post token=${WRITE_TOKEN} effort=[default] check=11`,
    );
    expect(run.calls).not.toContain("phase=finalize");
  });

  it("closes the check with validate's failure without posting", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    expect(
      m.run("validate", { STUB_VALIDATOR_ERROR: "turn cap reached" }).status,
    ).toBe(1);
    const run = m.run("after");
    expect(run.status).toBe(1);
    expect(run.calls).toContain(
      `lifecycle phase=finalize check=11 head=${HEAD} success=false error=turn cap reached`,
    );
    expect(run.calls).not.toContain("github-post-review.ts");
  });

  it("reads validate's error only from a regular file", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    const secret = path.join(m.home, "secret.txt");
    fs.writeFileSync(secret, "TOP SECRET");
    fs.symlinkSync(secret, m.errorFile);
    const run = m.run("after");
    expect(run.status).toBe(1);
    expect(run.calls).toContain(
      `lifecycle phase=finalize check=11 head=${HEAD} success=false error=The validator pass failed.`,
    );
    expect(run.calls + run.stdout + run.stderr).not.toContain("TOP SECRET");
  });

  it("closes the check when posting fails", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    const run = m.run("after", { STUB_POST_ERROR: "422 Unprocessable" });
    expect(run.status).toBe(1);
    expect(run.calls).toContain(
      `lifecycle phase=finalize check=11 head=${HEAD} success=false error=422 Unprocessable`,
    );
  });

  it.each(["validate", "after"] as const)(
    "%s does nothing when before prepared no review",
    (part) => {
      const m = machine();
      const run = m.run(part);
      expect(run.status).toBe(0);
      expect(run.entrypoints).toEqual([]);
      expect(run.stdout).toContain("nothing to do");
    },
  );

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
