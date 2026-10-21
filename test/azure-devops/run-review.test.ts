import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { tempDir } from "./helpers";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(REPO_ROOT, "azure-devops/run-review.sh");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Stub `bun` (entrypoints) and `droid` binaries record how run-review.sh
 * drives them, so the orchestration is tested without network or models.
 */
const BUN_STUB = `#!/usr/bin/env bash
echo "bun $*" >> "$STUB_LOG"
echo "cwd=$PWD sources=\${BUILD_SOURCESDIRECTORY:-unset}" >> "$STUB_LOG"
case "$*" in
  *azure-devops-prepare.ts)
    if [ "\${STUB_PREPARE_EXIT:-0}" != 0 ]; then exit "$STUB_PREPARE_EXIT"; fi
    printf '{\\n  "shouldRunReview": %s\\n}\\n' "\${STUB_SHOULD_RUN:-true}" > "$DROID_STATE_FILE"
    cat > "$(dirname "$DROID_PROMPT_FILE")/resolved-env.sh" <<'SHIM'
export RESOLVED_MODEL='openai-latest-premium'
export RESOLVED_REASONING_EFFORT='high'
export DROID_SESSION_TAG_CANDIDATES='{"name":"code-review","metadata":{"pass":"candidates"}}'
export DROID_SESSION_TAG_VALIDATOR='{"name":"code-review","metadata":{"pass":"validator"}}'
SHIM
    echo "pass1 prompt" > "$DROID_PROMPT_FILE"
    ;;
  *azure-devops-update-comment-link.ts)
    echo "update success=$DROID_SUCCESS details=$DROID_ERROR_DETAILS token=\${SYSTEM_ACCESSTOKEN:-none}" >> "$STUB_LOG"
    ;;
esac
exit 0
`;

const DROID_STUB = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "droid 0.0.0"; exit 0; fi
{
  echo "droid-call"
  for a in "$@"; do echo "arg:$a"; done
  echo "env:SYSTEM_ACCESSTOKEN=\${SYSTEM_ACCESSTOKEN-unset}"
  echo "env:AZURE_DEVOPS_PAT=\${AZURE_DEVOPS_PAT-unset}"
  echo "env:FACTORY_API_KEY=\${FACTORY_API_KEY-unset}"
} >> "$STUB_LOG"
echo '{"type":"completion","session_id":"s"}'
exit "\${STUB_DROID_EXIT:-0}"
`;

function runScript(env: Record<string, string> = {}, cwd?: string) {
  const root = tempDir("ado-run-");
  dirs.push(root);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "bun"), BUN_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "droid"), DROID_STUB, { mode: 0o755 });
  const log = path.join(root, "calls.log");
  fs.writeFileSync(log, "");
  const agentTemp = path.join(root, "agent-temp");
  fs.mkdirSync(agentTemp);

  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    cwd,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: path.join(root, "home"),
      AGENT_TEMPDIRECTORY: agentTemp,
      DROID_ACTION_DIR: REPO_ROOT,
      STUB_LOG: log,
      FACTORY_API_KEY: "fk-123",
      SYSTEM_ACCESSTOKEN: "job-token",
      AZURE_DEVOPS_PAT: "$(AZURE_DEVOPS_PAT)",
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout + result.stderr,
    calls: fs.readFileSync(log, "utf8"),
    debugDir: path.join(agentTemp, "droid-debug"),
    home: path.join(root, "home"),
  };
}

function droidCalls(calls: string): string[][] {
  return calls
    .split("droid-call\n")
    .slice(1)
    .map((chunk) => chunk.trim().split("\n"));
}

describe("azure-devops/run-review.sh", () => {
  it("runs both passes without Azure DevOps credentials, then posts and updates tracking", () => {
    const run = runScript();
    expect(run.status).toBe(0);

    const order = run.calls
      .split("\n")
      .filter((l) => l.startsWith("bun ") || l === "droid-call")
      .map((l) => l.replace(REPO_ROOT, "<repo>"));
    expect(order).toEqual([
      "bun install --frozen-lockfile",
      "bun run <repo>/src/entrypoints/azure-devops-prepare.ts",
      "droid-call",
      "bun run <repo>/src/entrypoints/azure-devops-prepare-validator.ts",
      "droid-call",
      "bun run <repo>/src/entrypoints/azure-devops-post-review.ts",
      "bun run <repo>/src/entrypoints/azure-devops-update-comment-link.ts",
    ]);

    const [pass1, pass2] = droidCalls(run.calls);
    for (const call of [pass1!, pass2!]) {
      expect(call).toContain("env:SYSTEM_ACCESSTOKEN=unset");
      expect(call).toContain("env:AZURE_DEVOPS_PAT=unset");
      expect(call).toContain("env:FACTORY_API_KEY=fk-123");
      expect(call).toContain("arg:--model");
      expect(call).toContain("arg:openai-latest-premium");
      expect(call).toContain("arg:--reasoning-effort");
    }
    expect(pass1).toContain(
      "arg:Read,Grep,Glob,LS,Execute,Edit,Create,ApplyPatch,Task,Skill,FetchUrl",
    );
    expect(pass1).toContain(
      'arg:{"name":"code-review","metadata":{"pass":"candidates"}}',
    );
    expect(pass2).toContain(
      "arg:Read,Grep,Glob,LS,Execute,Edit,Create,ApplyPatch,Skill",
    );
    expect(pass2).toContain(
      'arg:{"name":"code-review","metadata":{"pass":"validator"}}',
    );

    // The final step keeps the token: it has to write the tracking thread.
    expect(run.calls).toContain("update success=true details= token=job-token");
    expect(fs.existsSync(path.join(run.debugDir, "pass1-output.jsonl"))).toBe(
      true,
    );
  });

  it("runs every bun entrypoint from the droid-action checkout, not the PR checkout", () => {
    const checkout = tempDir("ado-checkout-");
    dirs.push(checkout);
    fs.writeFileSync(
      path.join(checkout, "bunfig.toml"),
      'preload = ["./steal.ts"]\n',
    );
    const run = runScript({}, checkout);
    expect(run.status).toBe(0);
    const cwds = run.calls.split("\n").filter((l) => l.startsWith("cwd="));
    // install, prepare, validator, post-review, update-comment-link
    expect(cwds).toHaveLength(5);
    for (const line of cwds) {
      expect(line).toBe(`cwd=${REPO_ROOT} sources=${checkout}`);
    }
  });

  it("marks the run failed and exits non-zero when a pass fails", () => {
    const run = runScript({ STUB_DROID_EXIT: "3" });
    expect(run.status).toBe(1);
    expect(droidCalls(run.calls)).toHaveLength(1);
    expect(run.calls).not.toContain("azure-devops-post-review.ts");
    expect(run.calls).toContain(
      "update success=false details=droid exec pass 1 (candidates) failed",
    );
    expect(run.stdout).toContain(
      "##vso[task.logissue type=error]droid exec pass 1",
    );
  });

  it("stops after prepare when the build should not be reviewed", () => {
    const run = runScript({ STUB_SHOULD_RUN: "false", FACTORY_API_KEY: "" });
    expect(run.status).toBe(0);
    expect(droidCalls(run.calls)).toHaveLength(0);
    expect(run.calls).toContain("update success=true");
  });

  it("fails with setup instructions when FACTORY_API_KEY never expanded", () => {
    const run = runScript({ FACTORY_API_KEY: "$(FACTORY_API_KEY)" });
    expect(run.status).toBe(1);
    expect(droidCalls(run.calls)).toHaveLength(0);
    expect(run.calls).toContain(
      "update success=false details=FACTORY_API_KEY is not set",
    );
  });

  it("fails before prepare when a PR build has no FACTORY_API_KEY", () => {
    const run = runScript({ BUILD_REASON: "PullRequest", FACTORY_API_KEY: "" });
    expect(run.status).toBe(1);
    expect(run.calls).not.toContain("azure-devops-prepare.ts");
    expect(run.calls).not.toContain("azure-devops-update-comment-link.ts");
    expect(run.stdout).toContain("FACTORY_API_KEY is not set");
    expect(run.stdout).toContain("Nothing was posted to the pull request");
  });

  it("skips fork pull requests before prepare, even without secrets", () => {
    const run = runScript({
      BUILD_REASON: "PullRequest",
      SYSTEM_PULLREQUEST_ISFORK: "True",
      FACTORY_API_KEY: "",
    });
    expect(run.status).toBe(0);
    expect(run.calls).not.toContain("azure-devops-prepare.ts");
    expect(run.calls).not.toContain("azure-devops-update-comment-link.ts");
    expect(run.stdout).toContain("pull request comes from a fork");
  });

  it("ignores a GitLab-style group/repo ORG_GUIDELINES_SOURCE", () => {
    const run = runScript({ ORG_GUIDELINES_SOURCE: "platform/review-rules" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      "ORG_GUIDELINES_SOURCE 'platform/review-rules' is not a file on the agent",
    );
    expect(run.stdout).not.toContain("could not clone");
    expect(
      fs.existsSync(
        path.join(run.home, ".factory/skills/org-review-guidelines"),
      ),
    ).toBe(false);
  });

  it("installs org guidelines from a file on the agent", () => {
    const file = path.join(tempDir("ado-guide-"), "rules.md");
    dirs.push(path.dirname(file));
    fs.writeFileSync(file, "Always check errors.\n");
    const run = runScript({ ORG_GUIDELINES_SOURCE: file });
    expect(run.status).toBe(0);
    expect(
      fs.readFileSync(
        path.join(run.home, ".factory/skills/org-review-guidelines/SKILL.md"),
        "utf8",
      ),
    ).toContain("Always check errors.");
  });

  it("does not touch the tracking thread when prepare fails before writing state", () => {
    const run = runScript({ STUB_PREPARE_EXIT: "1" });
    expect(run.status).toBe(1);
    expect(run.calls).not.toContain("azure-devops-update-comment-link.ts");
  });
});
