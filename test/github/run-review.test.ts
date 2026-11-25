import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const HEAD = "a".repeat(40);
const WRITE_TOKEN = "ghs_write_token";
const READ_TOKEN = "ghs_read_token";
// run-review.sh's SESSION_FILE_MAX_BYTES.
const SESSION_FILE_MAX_BYTES = 16 * 1024 * 1024;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Stub `bun` (entrypoints), `runuser`, `chown` and `env` binaries record how
 * run-review.sh drives them, so every part is tested without network, models
 * or root. The entrypoint stubs report outputs the way @actions/core does.
 * The validator and runuser get cleared environments, so the stubs read their
 * settings from stub.env; the validator stub records the environment it
 * received, and runuser runs its command with the session user's HOME.
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
    ;;
  *prepare.ts)
    echo "prepare actor=$GITHUB_ACTOR auto=[\${AUTOMATIC_REVIEW-unset}] security=[\${AUTOMATIC_SECURITY_REVIEW-unset}] default_auto=\${DEFAULT_AUTOMATIC_REVIEW-unset} only=\${AUTOMATIC_REVIEW_ONLY-unset} config=[\${REVIEW_CONFIG_JSON-unset}] override=$OVERRIDE_GITHUB_TOKEN cwd=$PWD prior=$REVIEW_PRIOR_FINDINGS_PATH prior_diff=$REVIEW_PRIOR_DIFF_PATH" >> "$STUB_LOG"
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
    echo "candidates prompt" > "$RUNNER_TEMP/droid-prompts/droid-prompt.txt"
    [ -n "\${STUB_NO_DIFF:-}" ] || echo "diff --git a/f b/f" > "$RUNNER_TEMP/droid-prompts/pr.diff"
    if [ -n "\${STUB_PREPARE_ERROR:-}" ]; then out prepare_error "$STUB_PREPARE_ERROR"; exit 1; fi
    if [ -n "\${STUB_PREPARE_CRASH:-}" ]; then exit 3; fi
    # The check is open: stop run-review.sh the way a timeout's SIGKILL does.
    if [ -n "\${STUB_KILL_BEFORE:-}" ]; then kill -9 "$PPID"; exit 0; fi
    ;;
  *github-review-lifecycle.ts)
    echo "lifecycle phase=$REVIEW_PHASE check=$REVIEW_CHECK_ID head=$REVIEW_HEAD_SHA success=\${DROID_SUCCESS-unset} error=\${DROID_POST_ERROR_MESSAGE:-}\${DROID_VALIDATOR_ERROR_MESSAGE:-}\${PREPARE_ERROR:-}" >> "$STUB_LOG"
    ;;
  *prepare-validator.ts)
    echo "validator-prompt effort=[$REASONING_EFFORT] depth=$REVIEW_DEPTH model=$REVIEW_MODEL comment=$DROID_COMMENT_ID token=$GITHUB_TOKEN prior=$REVIEW_PRIOR_FINDINGS_PATH" >> "$STUB_LOG"
    if [ "\${STUB_CANDIDATES:-valid}" = invalid ]; then out validator_should_run false; exit 0; fi
    out validator_should_run true
    out droid_args '--enabled-tools "Read"'
    out mcp_tools '{"mcpServers":{}}'
    ;;
  *base-action/src/index.ts)
    printf '%s\\n' "$received_env" > "__STUB_DIR__/validator.env"
    if [ -n "\${STUB_VALIDATOR_ERROR:-}" ]; then out error_message "$STUB_VALIDATOR_ERROR"; exit 1; fi
    echo approved > "$(dirname "$INPUT_PROMPT_FILE")/review_validated.json"
    ;;
  *github-post-review.ts)
    echo "post token=$GITHUB_TOKEN effort=[$REASONING_EFFORT] check=$REVIEW_CHECK_ID bun_options=\${BUN_OPTIONS-unset} git_config=$(git config --get droid.planted || echo unreadable) validated=$(cat "$REVIEW_VALIDATED_PATH" 2>/dev/null) from=$REVIEW_VALIDATED_PATH diff=$REVIEW_DIFF_PATH:$(head -n 1 "$REVIEW_DIFF_PATH" 2>/dev/null) prior_diff=$REVIEW_PRIOR_DIFF_PATH" >> "$STUB_LOG"
    if [ -n "\${STUB_POST_ERROR:-}" ]; then out error_message "$STUB_POST_ERROR"; exit 1; fi
    ;;
esac
exit 0
`;

const RUNUSER_STUB = `#!/usr/bin/env bash
. "__STUB_DIR__/stub.env"
[ "$1" = -u ] && [ "$3" = -- ] || exit 64
echo "runuser $2 token=\${GITHUB_TOKEN-unset} \${*:4}" >> "$STUB_LOG"
shift 3
HOME="__STUB_DIR__/session-home" exec "$@"
`;

const CHOWN_STUB = `#!/usr/bin/env bash
. "__STUB_DIR__/stub.env"
echo "chown $*" >> "$STUB_LOG"
[ -z "\${STUB_CHOWN_FAIL:-}" ] || exit 1
`;

// Serves any bun release download as a zip holding the bun stub, which the
// test moves to bin/bun-stub when it wants install_bun to run.
const CURL_STUB = `#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; https://*) url="$1" ;; esac
  shift
done
build="\${url##*/bun-}"
python3 - "$out" "bun-\${build%.zip}/bun" "__STUB_DIR__/bin/bun-stub" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.write(sys.argv[3], sys.argv[2])
PY
`;

// Any user can read env(1)'s arguments in /proc/<pid>/cmdline.
const ENV_STUB = `#!/usr/bin/env bash
echo "env $*" >> "__STUB_DIR__/calls.log"
exec /usr/bin/env "$@"
`;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** One machine: every part of a run shares its RUNNER_TEMP and HOME. */
function machine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-run-"));
  dirs.push(root);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const stubs = {
    bun: BUN_STUB,
    runuser: RUNUSER_STUB,
    chown: CHOWN_STUB,
    env: ENV_STUB,
    curl: CURL_STUB,
  };
  for (const [name, stub] of Object.entries(stubs))
    fs.writeFileSync(
      path.join(bin, name),
      stub.replaceAll("__STUB_DIR__", root),
      {
        mode: 0o755,
      },
    );
  // A copy of droid-action, so that with SESSION_USER the directories above
  // it are the test's own.
  const action = path.join(root, "action");
  fs.mkdirSync(path.join(action, "github"), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "github/run-review.sh"),
    path.join(action, "github/run-review.sh"),
  );
  fs.cpSync(
    path.join(REPO_ROOT, ".factory/droids"),
    path.join(action, ".factory/droids"),
    { recursive: true },
  );
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout);
  spawnSync("git", ["init", "-q", checkout]);
  const runnerTemp = path.join(root, "runner-temp");
  fs.mkdirSync(runnerTemp);
  const home = path.join(root, "home");
  const sessionHome = path.join(root, "session-home");
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(tmp);
  const log = path.join(root, "calls.log");
  const validatorEnvFile = path.join(root, "validator.env");
  const prompts = path.join(runnerTemp, "droid-prompts");
  const stateDir = path.join(runnerTemp, "github-review");

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
    const result = spawnSync(
      "bash",
      [path.join(action, "github/run-review.sh"), part],
      {
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
          GITHUB_ACTOR: "octocat",
          FACTORY_API_KEY: "fk-123",
          // What a caller passes after when validate exited 0.
          VALIDATE_RESULT: "succeeded",
          ...env,
        },
      },
    );
    const calls = fs.readFileSync(log, "utf8");
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      calls,
      entrypoints: calls
        .split("\n")
        .filter((l) => l.startsWith("bun "))
        .map((l) =>
          l.replace(
            `bun --config=/dev/null --env-file=/dev/null run ${action}/`,
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
  return {
    run,
    bin,
    action,
    checkout,
    runnerTemp,
    home,
    sessionHome,
    tmp,
    prompts,
    stateDir,
    stateFile: path.join(stateDir, "state"),
    beforeDir: path.join(stateDir, "before"),
    errorFile: path.join(prompts, "github-review-error"),
  };
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
    // author as actor, no review configuration carried in, and automatic
    // review on only by default.
    expect(run.calls).toContain(
      `prepare actor=octocat auto=[unset] security=[unset] default_auto=true only=true config=[] override=${WRITE_TOKEN} cwd=${m.checkout} prior=${path.join(m.prompts, "review_prior_findings.json")} prior_diff=${path.join(m.stateDir, "review_prior_diff.json")}`,
    );
    // The token reaches prepare through its environment, not env(1)'s arguments.
    expect(run.calls).toContain(
      "env REVIEW_CONFIG_JSON= DEFAULT_AUTOMATIC_REVIEW=true AUTOMATIC_REVIEW_ONLY=true TMPDIR=",
    );
    for (const call of run.calls
      .split("\n")
      .filter((l) => l.startsWith("env ")))
      expect(call).not.toContain(WRITE_TOKEN);
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

  it("passes the caller's review settings to prepare instead of forcing them", () => {
    const m = machine();
    const run = m.run("before", {
      AUTOMATIC_REVIEW: "false",
      AUTOMATIC_SECURITY_REVIEW: "true",
    });
    expect(run.status).toBe(0);
    expect(run.calls).toContain(
      "auto=[false] security=[true] default_auto=true",
    );
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
    [
      { STUB_PREPARE_CRASH: "1" },
      HEAD,
      "Preparing the review failed with exit status 3.",
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

  it("names a failed droid copy on the check", () => {
    const m = machine();
    fs.rmSync(path.join(m.action, ".factory/droids"), { recursive: true });
    const run = m.run("before");
    expect(run.status).toBe(1);
    expect(run.calls).toContain(
      `lifecycle phase=finalize check=11 head=${HEAD} success=false error=Could not copy the review droids into ${os.userInfo().username}'s ~/.factory/droids.`,
    );
  });

  it("names a failed diff copy on the check", () => {
    const m = machine();
    const run = m.run("before", { STUB_NO_DIFF: "1" });
    expect(run.status).toBe(1);
    expect(run.calls).toContain(
      `lifecycle phase=finalize check=11 head=${HEAD} success=false error=Could not keep a copy of the PR diff for posting.`,
    );
  });

  it("leaves GitHub alone when prepare fails before opening a check", () => {
    const m = machine();
    const run = m.run("before", {
      STUB_PREPARE_ERROR: "Actor does not have write permissions",
      STUB_REVIEW_HEAD: "",
    });
    expect(run.status).toBe(1);
    expect(run.calls).not.toContain("lifecycle");
  });

  it.each(["GITHUB_RUN_ID", "RUNNER_TEMP", "GITHUB_ACTOR"])(
    "fails before doing anything without %s",
    (name) => {
      const m = machine();
      const run = m.run("before", { [name]: "" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(name);
      expect(run.entrypoints).toEqual([]);
    },
  );

  it("refuses a relative RUNNER_TEMP, which after would resolve elsewhere", () => {
    const m = machine();
    const run = m.run("before", { RUNNER_TEMP: "runner-temp" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("RUNNER_TEMP must be an absolute path");
    expect(run.entrypoints).toEqual([]);
  });
});

describe("github/run-review.sh validate", () => {
  it("leaves after only its own outcome", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    // Results the session wrote itself, and an earlier attempt's error.
    const validated = path.join(m.prompts, "review_validated.json");
    fs.writeFileSync(validated, "planted");
    fs.writeFileSync(m.errorFile, "stale error\n");
    const run = m.run("validate", { FACTORY_API_KEY: "" });
    expect(run.status).toBe(1);
    expect(run.entrypoints).toEqual([]);
    expect(fs.existsSync(validated)).toBe(false);
    expect(fs.readFileSync(m.errorFile, "utf8")).toBe(
      "FACTORY_API_KEY is required for the validator pass.\n",
    );
  });

  it("clears an earlier attempt's error when it succeeds", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    expect(
      m.run("validate", { STUB_VALIDATOR_ERROR: "turn cap reached" }).status,
    ).toBe(1);
    expect(m.run("validate").status).toBe(0);
    expect(fs.existsSync(m.errorFile)).toBe(false);
  });

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
      "src/entrypoints/github-pr-event.ts",
      "src/entrypoints/prepare-validator.ts",
      "base-action/src/index.ts",
    ]);
    // The validator prompt gets prepare's model and depth, and no effort for
    // the "default" label, as action.yml passes them.
    expect(run.calls).toContain(
      `validator-prompt effort=[] depth=shallow model=openai-latest-fast comment=22 token=${READ_TOKEN} prior=${path.join(m.prompts, "review_prior_findings.json")}`,
    );
    const { PWD, SHLVL, _, ...validatorEnv } = run.validatorEnv!;
    expect(validatorEnv).toEqual({
      PATH: expect.any(String),
      HOME: m.home,
      RUNNER_TEMP: m.runnerTemp,
      FACTORY_API_KEY: "fk-123",
      DROID_EXEC_RUN_TYPE: "droid-review",
      FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
      INPUT_MAX_TURNS: "40",
      INPUT_PROMPT_FILE: path.join(m.prompts, "droid-prompt.txt"),
      INPUT_DROID_ARGS: '--enabled-tools "Read"',
      INPUT_MCP_TOOLS: '{"mcpServers":{}}',
      TMPDIR: expect.stringContaining(m.tmp),
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
});

describe("github/run-review.sh after", () => {
  it("posts the review with the token and closes the check", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    expect(m.run("validate").status).toBe(0);
    const run = m.run("after");
    expect(run.status).toBe(0);
    expect(run.entrypoints).toEqual([
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
    expect(run.calls).toContain("validated=approved");
    // The prior diff prepare kept, in before's own directory.
    expect(run.calls).toContain(
      `prior_diff=${path.join(m.stateDir, "review_prior_diff.json")}`,
    );
    expect(run.calls).not.toContain("phase=finalize");
  });

  it("stops reading a session file that never ends", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    fs.symlinkSync("/dev/zero", path.join(m.prompts, "review_validated.json"));
    const run = m.run("after");
    expect(run.calls).toContain("validated= from=");
  });

  it.each([
    ["uses", SESSION_FILE_MAX_BYTES, "approved"],
    ["drops", SESSION_FILE_MAX_BYTES + 1, ""],
  ])("%s a session file of %i bytes", (_verb, size, validated) => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    fs.writeFileSync(
      path.join(m.prompts, "review_validated.json"),
      "approved".padEnd(size, "\n"),
    );
    const run = m.run("after");
    expect(run.calls).toContain(`validated=${validated} from=`);
  });

  it("keeps git away from config the session could have planted", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    // In the clone, and in a repository above after's private directory.
    spawnSync("git", ["-C", m.checkout, "config", "droid.planted", "yes"]);
    spawnSync("git", ["init", "-q", m.tmp]);
    spawnSync("git", ["-C", m.tmp, "config", "droid.planted", "yes"]);
    const run = m.run("after");
    expect(run.status).toBe(0);
    expect(run.calls).toContain("git_config=unreadable");
  });

  it("closes the check with the error validate left, whatever VALIDATE_RESULT says", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    expect(
      m.run("validate", { STUB_VALIDATOR_ERROR: "turn cap reached" }).status,
    ).toBe(1);
    const run = m.run("after", { VALIDATE_RESULT: "succeeded" });
    expect(run.status).toBe(1);
    expect(run.calls).toContain(
      `lifecycle phase=finalize check=11 head=${HEAD} success=false error=turn cap reached`,
    );
    expect(run.calls).not.toContain("github-post-review.ts");
  });

  it.each([
    ["failed", "The validator pass failed."],
    ["timed-out", "The validator pass failed."],
    ["", "VALIDATE_RESULT is required to post the review."],
  ])(
    "closes the check without posting when validate's result is [%s]",
    (result, error) => {
      const m = machine();
      expect(m.run("before").status).toBe(0);
      expect(m.run("validate").status).toBe(0);
      const run = m.run("after", { VALIDATE_RESULT: result });
      expect(run.status).toBe(1);
      expect(run.calls).toContain(
        `lifecycle phase=finalize check=11 head=${HEAD} success=false error=${error}`,
      );
      expect(run.calls).not.toContain("github-post-review.ts");
    },
  );

  it("closes the check when posting fails", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    const run = m.run("after", { STUB_POST_ERROR: "422 Unprocessable" });
    expect(run.status).toBe(1);
    expect(run.calls).toContain(
      `lifecycle phase=finalize check=11 head=${HEAD} success=false error=422 Unprocessable`,
    );
  });

  it("closes the check that a stopped before left open", () => {
    const m = machine();
    expect(m.run("before", { STUB_KILL_BEFORE: "1" }).signal).toBe("SIGKILL");
    expect(fs.existsSync(m.beforeDir)).toBe(true);
    const validate = m.run("validate");
    expect(validate.status).toBe(0);
    expect(validate.entrypoints).toEqual([]);
    const run = m.run("after");
    expect(run.status).toBe(1);
    expect(run.entrypoints).toEqual([
      "src/entrypoints/github-review-lifecycle.ts",
    ]);
    expect(run.calls).toContain(
      `lifecycle phase=finalize check=11 head=${HEAD} success=false error=Droid was stopped while preparing the review of ${HEAD}; nothing was posted.`,
    );
    // It held prepare's outputs, the token among them.
    expect(fs.existsSync(m.beforeDir)).toBe(false);
  });

  it("only cleans up after a before stopped before it opened a check", () => {
    const m = machine();
    expect(
      m.run("before", { STUB_KILL_BEFORE: "1", STUB_REVIEW_HEAD: "" }).signal,
    ).toBe("SIGKILL");
    const run = m.run("after");
    expect(run.status).toBe(0);
    expect(run.entrypoints).toEqual([]);
    expect(fs.existsSync(m.beforeDir)).toBe(false);
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

  it("closes the check without posting when the review was prepared for another commit", () => {
    const m = machine();
    expect(m.run("before").status).toBe(0);
    const other = "d".repeat(40);
    const run = m.run("after", { PR_HEAD_SHA: other });
    expect(run.status).toBe(1);
    expect(run.calls).toContain(
      `lifecycle phase=finalize check=11 head=${HEAD} success=false error=The prepared review is for ${HEAD}, not ${other}; nothing was posted.`,
    );
    expect(run.calls).not.toContain("github-post-review.ts");
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

// runuser, and the stat and realpath flags the checks use, are Linux's.
describe.skipIf(process.platform !== "linux")(
  "github/run-review.sh with SESSION_USER",
  () => {
    const asRoot = { SESSION_USER: "reviewer" };

    it("hands the clone over and reads the session's files as the session user", () => {
      const m = machine();
      const before = m.run("before", asRoot);
      expect(before.status).toBe(0);
      expect(before.calls).toContain(
        `chown -R reviewer: -- ${m.prompts} ${m.checkout}\n`,
      );
      // The droids are copied as the session user, into its HOME.
      expect(before.calls).toContain("runuser reviewer token=unset sh -c");
      expect(
        fs.existsSync(
          path.join(m.sessionHome, ".factory/droids/security-reviewer.md"),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(m.home, ".factory"))).toBe(false);

      expect(m.run("validate", { HOME: m.sessionHome }).status).toBe(0);
      const after = m.run("after", asRoot);
      expect(after.status).toBe(0);
      for (const name of ["review_candidates.json", "review_validated.json"])
        expect(after.calls).toContain(
          `runuser reviewer token=unset timeout 30 head -c ${SESSION_FILE_MAX_BYTES + 1} -- ${path.join(m.prompts, name)}\n`,
        );
      // Posting reads those copies and before's own copy of the diff.
      expect(after.calls).toContain("validated=approved from=");
      expect(after.calls).not.toContain(`from=${m.prompts}`);
      expect(after.calls).toContain(
        `diff=${path.join(m.stateDir, "pr.diff")}:diff --git a/f b/f`,
      );
    });

    it("reads validate's error as the session user", () => {
      const m = machine();
      expect(m.run("before", asRoot).status).toBe(0);
      expect(
        m.run("validate", {
          HOME: m.sessionHome,
          STUB_VALIDATOR_ERROR: "turn cap reached",
        }).status,
      ).toBe(1);
      const run = m.run("after", { ...asRoot, VALIDATE_RESULT: "failed" });
      expect(run.status).toBe(1);
      expect(run.calls).toContain(
        `runuser reviewer token=unset timeout 30 head -c 2000 -- ${m.errorFile}\n`,
      );
      expect(run.calls).toContain(
        `lifecycle phase=finalize check=11 head=${HEAD} success=false error=turn cap reached`,
      );
    });

    it("before replaces prompts an earlier session left instead of writing through them", () => {
      const m = machine();
      const elsewhere = `${m.runnerTemp}-elsewhere`;
      fs.mkdirSync(elsewhere);
      fs.symlinkSync(elsewhere, m.prompts);
      expect(m.run("before", asRoot).status).toBe(0);
      expect(fs.lstatSync(m.prompts).isDirectory()).toBe(true);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    });

    it("before refuses a RUNNER_TEMP another user could change", () => {
      const m = machine();
      fs.chmodSync(m.runnerTemp, 0o777);
      const run = m.run("before", asRoot);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        `Only root may be able to change ${m.runnerTemp} `,
      );
      expect(run.entrypoints).toEqual([]);
    });

    it("before refuses a RUNNER_TEMP reached through a symbolic link", () => {
      const m = machine();
      const link = `${m.runnerTemp}-link`;
      fs.symlinkSync(m.runnerTemp, link);
      const run = m.run("before", { ...asRoot, RUNNER_TEMP: link });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`Give ${link} as ${m.runnerTemp},`);
      expect(run.entrypoints).toEqual([]);
    });

    it("after refuses state another user could have written", () => {
      const m = machine();
      expect(m.run("before", asRoot).status).toBe(0);
      fs.chmodSync(m.stateDir, 0o777);
      const run = m.run("after", asRoot);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        `Only root may be able to change ${m.stateDir} `,
      );
      expect(run.entrypoints).toEqual([]);
    });

    it("before names the failed hand-over on the check", () => {
      const m = machine();
      const run = m.run("before", { ...asRoot, STUB_CHOWN_FAIL: "1" });
      expect(run.status).toBe(1);
      expect(run.calls).toContain(
        `lifecycle phase=finalize check=11 head=${HEAD} success=false error=Could not hand the clone and prompts over to reviewer.`,
      );
      expect(fs.existsSync(m.stateFile)).toBe(false);
    });

    it("after refuses what a stopped before left where another user could write", () => {
      const m = machine();
      expect(m.run("before", { ...asRoot, STUB_KILL_BEFORE: "1" }).signal).toBe(
        "SIGKILL",
      );
      fs.chmodSync(m.stateDir, 0o777);
      const run = m.run("after", asRoot);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        `Only root may be able to change ${m.stateDir} `,
      );
      expect(run.entrypoints).toEqual([]);
    });

    it("before installs no bun whose SHA-256 differs from the pinned one", () => {
      const m = machine();
      fs.renameSync(path.join(m.bin, "bun"), path.join(m.bin, "bun-stub"));
      const run = m.run("before", asRoot);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("did NOT match");
      expect(run.entrypoints).toEqual([]);
      expect(fs.existsSync(path.join(m.home, ".bun/bin/bun"))).toBe(false);
    });

    it("will not run validate as another user than the session's", () => {
      const m = machine();
      expect(m.run("before", asRoot).status).toBe(0);
      const run = m.run("validate", asRoot);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("Run validate as reviewer");
      expect(run.entrypoints).toEqual([]);
    });
  },
);
