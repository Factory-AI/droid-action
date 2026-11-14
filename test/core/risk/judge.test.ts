import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildJudgeEnvironment,
  runPrRiskJudge,
} from "../../../src/core/risk/judge";
import { buildPrRiskSnapshot } from "../../../src/core/risk/snapshot";
import type { RiskJudgeAttempt } from "../../../src/core/risk/types";
import {
  evidenceAt,
  execSummary,
  file,
  judge,
  pullRequest,
  validVerdict,
} from "./fixtures";

const snapshot = buildPrRiskSnapshot(pullRequest, [
  file("packages/common/src/session.ts"),
]);

const SKILL_PATH = [".factory", "skills", "pr-risk-judge", "SKILL.md"];

describe("runPrRiskJudge", () => {
  let evidenceRoot = "";
  const env = { PATH: process.env.PATH };

  beforeAll(async () => {
    evidenceRoot = await mkdtemp(join(tmpdir(), "pr-risk-judge-test-"));
  });

  afterAll(async () => {
    await rm(evidenceRoot, { recursive: true, force: true });
  });

  async function standInDroid(name: string, script: string): Promise<string> {
    const path = join(evidenceRoot, name);
    await writeFile(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return path;
  }

  it("installs the rendered skill as the project skill, writes the settings file, and invokes it", async () => {
    const invocations: Array<{ args: readonly string[]; cwd: string }> = [];
    const attempts: RiskJudgeAttempt[] = [];

    const verdict = await runPrRiskJudge(snapshot, {
      judge,
      evidence: evidenceAt(evidenceRoot),
      env,
      onAttempt: (attempt) => attempts.push(attempt),
      executeDroid: async ({ args, cwd, timeoutMs }) => {
        invocations.push({ args, cwd });
        const skill = await readFile(join(cwd, ...SKILL_PATH), "utf8");
        expect(skill.startsWith("---\nname: pr-risk-judge\n")).toBe(true);
        expect(skill).toContain('"prNumber": 123');
        expect(skill).not.toContain("{{PR_SNAPSHOT_JSON}}");
        const settingsPath = args[args.indexOf("--settings") + 1] ?? "";
        expect(args.slice(0, 3)).toEqual(["--settings", settingsPath, "exec"]);
        expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(
          judge.settings,
        );
        expect(timeoutMs).toBe(1000);
        return execSummary(validVerdict);
      },
    });

    expect(invocations).toHaveLength(1);
    const args = invocations[0]?.args ?? [];
    expect(invocations[0]?.cwd).toBe(evidenceRoot);
    expect(args).toContain("--disable-builtin-skills");
    expect(args[args.indexOf("--auto") + 1]).toBe("high");
    expect(args[args.indexOf("--tag") + 1]).toBe("riskAssessment");
    expect(args[args.indexOf("--only-tools") + 1]).toBe("Read,Grep,Task");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args[args.indexOf("--cwd") + 1]).toBe(evidenceRoot);
    expect(args.at(-1)).toBe("/pr-risk-judge");
    expect(args).not.toContain("--model");
    expect(verdict).toEqual(validVerdict);
    expect(attempts).toEqual([{ sessionId: "session-1", valid: true }]);
  });

  it("retries once with the exact contract when the answer carries an undeclared key", async () => {
    const outputs = [
      { ...validVerdict, confidence: 5 },
      { ...validVerdict, details: "Restated." },
    ];
    const skills: string[] = [];
    const attempts: RiskJudgeAttempt[] = [];
    const invocations: Array<readonly string[]> = [];

    const verdict = await runPrRiskJudge(snapshot, {
      judge,
      evidence: evidenceAt(evidenceRoot),
      env,
      onAttempt: (attempt) => attempts.push(attempt),
      executeDroid: async ({ args, cwd }) => {
        invocations.push(args);
        skills.push(await readFile(join(cwd, ...SKILL_PATH), "utf8"));
        return execSummary(outputs[skills.length - 1], `s${skills.length}`);
      },
    });

    expect(verdict).toEqual({ ...validVerdict, details: "Restated." });
    expect(invocations).toHaveLength(2);
    for (const args of invocations) {
      expect(args[args.indexOf("--tag") + 1]).toBe("riskAssessment");
    }
    expect(attempts).toEqual([
      {
        sessionId: "s1",
        valid: false,
        invalidReason: "schema",
        invalidPaths: ["<root>"],
        invalidCodes: ["unrecognized_keys"],
        retryFeedback: ["<root>: unrecognized_keys"],
      },
      { sessionId: "s2", valid: true },
    ]);
    expect(skills[0]).not.toContain("## Strict retry");
    expect(skills[1]).toContain("## Strict retry");
    expect(skills[1]).toContain("- <root>: unrecognized_keys");
    expect(skills[1]).toContain(
      [
        "- verdict (boolean)",
        "- brief (string; one to three Markdown bullets shown under the headline, cut at 800 characters)",
        '- details (string; the Markdown body of the "Why this decision" drawer, cut at 6000 characters)',
        "- scores (object with exactly these integer keys: blastRadius 1-5, testCoverage 0-3)",
      ].join("\n"),
    );
  });

  it("holds scores to their declared ranges and fails after the retry", async () => {
    const attempts: RiskJudgeAttempt[] = [];

    await expect(
      runPrRiskJudge(snapshot, {
        judge,
        evidence: evidenceAt(evidenceRoot),
        env,
        onAttempt: (attempt) => attempts.push(attempt),
        executeDroid: () =>
          Promise.resolve(
            execSummary({
              ...validVerdict,
              scores: { blastRadius: 9, testCoverage: 3 },
            }),
          ),
      }),
    ).rejects.toMatchObject({
      reason: "invalid_pr_risk_verdict",
      message: "PR risk judge produced no valid verdict",
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      invalidReason: "schema",
      invalidPaths: ["scores.blastRadius"],
      invalidCodes: ["too_big"],
    });
  });

  it("cuts an over-long answer instead of rejecting it", async () => {
    const verdict = await runPrRiskJudge(snapshot, {
      judge,
      evidence: evidenceAt(evidenceRoot),
      env,
      executeDroid: () =>
        Promise.resolve(
          execSummary({ ...validVerdict, brief: "b".repeat(5000) }),
        ),
    });

    expect(verdict.brief).toHaveLength(800);
    expect(verdict.brief.endsWith("…")).toBe(true);
  });

  it("reads the verdict out of surrounding prose and records a session that errored", async () => {
    const attempts: RiskJudgeAttempt[] = [];
    const outputs = [
      JSON.stringify({ is_error: true, result: "boom", session_id: "dead" }),
      execSummary(
        `Here is my verdict:\n\n\`\`\`json\n${JSON.stringify(validVerdict)}\n\`\`\`\n`,
      ),
    ];

    const verdict = await runPrRiskJudge(snapshot, {
      judge,
      evidence: evidenceAt(evidenceRoot),
      env,
      onAttempt: (attempt) => attempts.push(attempt),
      executeDroid: () => Promise.resolve(outputs[attempts.length] ?? ""),
    });

    expect(verdict).toEqual(validVerdict);
    expect(attempts[0]).toEqual({
      sessionId: "dead",
      valid: false,
      invalidReason: "exec_error",
      retryFeedback: ["<root>: the session ended in an error"],
    });
  });

  it("treats a result with no JSON object as no_json", async () => {
    const attempts: RiskJudgeAttempt[] = [];

    await expect(
      runPrRiskJudge(snapshot, {
        judge,
        evidence: evidenceAt(evidenceRoot),
        env,
        onAttempt: (attempt) => attempts.push(attempt),
        executeDroid: () => Promise.resolve(execSummary("I decline.")),
      }),
    ).rejects.toThrow("PR risk judge produced no valid verdict");

    expect(attempts.map((attempt) => attempt.invalidReason)).toEqual([
      "no_json",
      "no_json",
    ]);
  });

  it("reports a judge that runs out of time as a timeout rather than an unexpected failure", async () => {
    // Like droid exec, the stand-in handles SIGTERM itself and exits 143, so
    // the kill is reported with an exit code rather than a signal.
    const slowDroid = await standInDroid(
      "slow-droid",
      'sleep 30 &\nchild=$!\ntrap \'kill "$child"; exit 143\' TERM\nwait "$child"',
    );
    const attempts: RiskJudgeAttempt[] = [];

    await expect(
      runPrRiskJudge(snapshot, {
        judge,
        evidence: evidenceAt(evidenceRoot),
        env,
        droidBinary: slowDroid,
        onAttempt: (attempt) => attempts.push(attempt),
      }),
    ).rejects.toMatchObject({
      message: "PR risk judge timed out",
      reason: "judge_timeout",
    });

    expect(attempts).toEqual([]);
  });

  it("reads the failure summary a session prints before exiting non-zero", async () => {
    const failingDroid = await standInDroid(
      "failing-droid",
      `printf '%s' '${JSON.stringify({ is_error: true, result: "boom", session_id: "exit-1" })}'\nexit 1`,
    );
    const attempts: RiskJudgeAttempt[] = [];

    await expect(
      runPrRiskJudge(snapshot, {
        judge,
        evidence: evidenceAt(evidenceRoot),
        env,
        droidBinary: failingDroid,
        onAttempt: (attempt) => attempts.push(attempt),
      }),
    ).rejects.toMatchObject({ reason: "invalid_pr_risk_verdict" });

    expect(attempts.map((attempt) => attempt.sessionId)).toEqual([
      "exit-1",
      "exit-1",
    ]);
  });

  it("reports a process that dies without a summary by exit code only, never by what it printed", async () => {
    const brokenDroid = await standInDroid(
      "broken-droid",
      'echo "the judge was shown: SECRET-EVIDENCE" >&2\nexit 7',
    );

    const failure = await runPrRiskJudge(snapshot, {
      judge,
      evidence: evidenceAt(evidenceRoot),
      env,
      droidBinary: brokenDroid,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      reason: "judge_exec_failed",
      message: "PR risk judge process failed (7)",
    });
    expect(String(failure)).not.toContain("SECRET-EVIDENCE");
  });

  it("starts the session with only the environment it is given", async () => {
    const recordingDroid = await standInDroid(
      "recording-droid",
      `env > droid-env.txt\nprintf '%s' '${execSummary(validVerdict)}'`,
    );
    const job = {
      FACTORY_API_KEY: "factory-key",
      GITHUB_TOKEN: "workflow-token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example",
      ACTIONS_RUNTIME_TOKEN: "runtime-token",
    };
    const saved = Object.fromEntries(
      Object.keys(job).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, job);
    try {
      await runPrRiskJudge(snapshot, {
        judge,
        evidence: evidenceAt(evidenceRoot),
        env: buildJudgeEnvironment(
          { group: judge.group, repo: "acme/app", githubToken: "read-token" },
          process.env,
        ),
        droidBinary: recordingDroid,
      });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    const session = Object.fromEntries(
      (await readFile(join(evidenceRoot, "droid-env.txt"), "utf8"))
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    expect(session).toMatchObject({
      FACTORY_API_KEY: "factory-key",
      GH_TOKEN: "read-token",
      GH_REPO: "acme/app",
      DROID_EXEC_RUN_TYPE: "group-a",
    });
    // The shell adds the last four itself.
    const allowed = new Set([
      "PATH",
      "HOME",
      "TMPDIR",
      "XDG_CONFIG_HOME",
      "FACTORY_API_KEY",
      "GH_TOKEN",
      "GH_REPO",
      "DROID_EXEC_RUN_TYPE",
      "PWD",
      "OLDPWD",
      "SHLVL",
      "_",
    ]);
    expect(Object.keys(session).filter((name) => !allowed.has(name))).toEqual(
      [],
    );
  });
});

describe("buildJudgeEnvironment", () => {
  it("keeps the Factory key and the read token and drops every other credential of the job", () => {
    expect(
      buildJudgeEnvironment(
        {
          group: "group-a",
          repo: "acme/app",
          githubToken: "read-token",
          apiBaseUrl: "https://factory.example",
        },
        {
          PATH: "/usr/bin",
          HOME: "/home/runner",
          FACTORY_API_KEY: "factory-key",
          GITHUB_TOKEN: "workflow-token",
          GH_TOKEN: "another-token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example",
          ACTIONS_RUNTIME_TOKEN: "runtime-token",
          FACTORY_API_BASE_URL: "https://ambient.example",
          RISK_PLAN_PATH: "/tmp/pr-risk/plan.json",
        },
      ),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      FACTORY_API_KEY: "factory-key",
      GH_TOKEN: "read-token",
      GH_REPO: "acme/app",
      FACTORY_API_BASE_URL: "https://factory.example",
      DROID_EXEC_RUN_TYPE: "group-a",
    });
  });
});
