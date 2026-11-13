import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildRiskSnapshot } from "../../src/risk/evidence";
import {
  executeRiskDroid,
  parseRiskJudgeOutput,
  riskJudgeEnvironment,
  RiskJudgeTimeoutError,
  runRiskJudge,
  type RiskDroidInvocation,
} from "../../src/risk/judge";
import { evidenceAt, execSummary, judgePlan, sha } from "./fixtures";

const scores = judgePlan().judge.scores;
const answer = {
  verdict: true,
  brief: "Small and contained.",
  details: "Touches one helper.",
  scores: { blastRadius: 2 },
};

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "risk-judge-test-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("parseRiskJudgeOutput", () => {
  it("reads an answer that is the whole final message", () => {
    expect(
      parseRiskJudgeOutput(execSummary(JSON.stringify(answer)), scores),
    ).toEqual({ sessionId: "session-1", verdict: answer });
  });

  it("reads the last fenced block of a message that also holds prose and an earlier draft", () => {
    const message = [
      "Draft:",
      "```json",
      JSON.stringify({ ...answer, verdict: false }),
      "```",
      "Final answer:",
      "```json",
      JSON.stringify(answer, null, 2),
      "```",
    ].join("\n");
    expect(parseRiskJudgeOutput(execSummary(message), scores).verdict).toEqual(
      answer,
    );
  });

  it("reads a fenced answer whose details quote a code fence and braces", () => {
    const quoting = {
      ...answer,
      details: 'Changes:\n```ts\nif (a) { b("}") }\n```\nand more.',
    };
    const message = `Here it is.\n\`\`\`json\n${JSON.stringify(quoting)}\n\`\`\`\n`;
    expect(parseRiskJudgeOutput(execSummary(message), scores).verdict).toEqual(
      quoting,
    );
  });

  it("reads a trailing object that follows prose", () => {
    expect(
      parseRiskJudgeOutput(
        execSummary(`I looked at {the diff}. ${JSON.stringify(answer)}`),
        scores,
      ).verdict,
    ).toEqual(answer);
  });

  it("names the failed rules, and never the rejected values, for an answer outside the shape", () => {
    const parsed = parseRiskJudgeOutput(
      execSummary(
        JSON.stringify({
          ...answer,
          scores: { blastRadius: 9 },
          approve: "synthetic-injected-value",
        }),
      ),
      scores,
    );
    expect(parsed).toEqual({
      sessionId: "session-1",
      invalidReason: "schema",
      invalidPaths: ["scores.blastRadius", "<root>"],
      invalidCodes: ["too_big", "unrecognized_keys"],
      retryFeedback: [
        "scores.blastRadius: too_big",
        "<root>: unrecognized_keys",
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("synthetic-injected-value");
  });

  it("refuses scores from a judge that declares none", () => {
    const { scores: _scores, ...plain } = answer;
    expect(
      parseRiskJudgeOutput(execSummary(JSON.stringify(plain)), {}),
    ).toEqual({ sessionId: "session-1", verdict: plain });
    expect(
      parseRiskJudgeOutput(execSummary(JSON.stringify(answer)), {}),
    ).toMatchObject({
      invalidReason: "schema",
      retryFeedback: ["<root>: unrecognized_keys"],
    });
  });

  it("refuses an answer too large to publish", () => {
    const parsed = parseRiskJudgeOutput(
      execSummary(
        JSON.stringify({ ...answer, details: "x".repeat(129 * 1024) }),
      ),
      scores,
    );
    expect(parsed).toMatchObject({
      invalidReason: "schema",
      retryFeedback: ["<root>: too_big"],
    });
  });

  it("reports a message without an object, a failed session and unreadable output", () => {
    expect(
      parseRiskJudgeOutput(execSummary("I could not decide."), scores),
    ).toMatchObject({ sessionId: "session-1", invalidReason: "no_json" });
    expect(
      parseRiskJudgeOutput(execSummary(JSON.stringify(answer), true), scores),
    ).toMatchObject({ sessionId: "session-1", invalidReason: "exec_error" });
    for (const stdout of ["", "not json", '{"result":"x"}'])
      expect(parseRiskJudgeOutput(stdout, scores)).toEqual({
        invalidReason: "exec_error",
        retryFeedback: ["<root>: the session produced no result"],
      });
  });
});

describe("riskJudgeEnvironment", () => {
  it("is exactly the allow-list, with a private home and nothing inherited", () => {
    process.env.RISK_TEST_INHERITED = "synthetic-inherited-value";
    try {
      const evidence = evidenceAt("/work");
      const env = riskJudgeEnvironment({
        evidence,
        path: "/usr/bin:/bin",
        factoryApiKey: "synthetic-factory-key",
        githubToken: "synthetic-read-token",
        repo: "acme/widgets",
        group: "skill-v4",
      });
      expect(env).toEqual({
        PATH: "/usr/bin:/bin",
        HOME: "/work/home",
        XDG_CONFIG_HOME: "/work/home/.config",
        XDG_CACHE_HOME: "/work/home/.cache",
        XDG_DATA_HOME: "/work/home/.local/share",
        TMPDIR: "/work/tmp",
        FACTORY_API_KEY: "synthetic-factory-key",
        FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
        GH_TOKEN: "synthetic-read-token",
        GH_REPO: "acme/widgets",
        DROID_EXEC_RUN_TYPE: "skill-v4",
      });
      expect(
        riskJudgeEnvironment({
          evidence,
          path: "/usr/bin",
          factoryApiKey: "k",
          factoryApiBaseUrl: "https://preview.example",
          githubToken: "t",
          repo: "acme/widgets",
          group: "g",
        }).FACTORY_API_BASE_URL,
      ).toBe("https://preview.example");
    } finally {
      delete process.env.RISK_TEST_INHERITED;
    }
  });
});

describe("runRiskJudge", () => {
  const snapshot = buildRiskSnapshot(
    {
      repo: "acme/widgets",
      prNumber: 42,
      title: "Tidy a helper",
      baseSha: sha("b"),
      headSha: sha("a"),
      additions: 3,
      deletions: 1,
      changedFiles: 1,
    },
    [{ filename: "src/a.ts", status: "modified", additions: 3, deletions: 1 }],
    [],
  );

  async function judgeWith(stdouts: string[]) {
    const workDir = await mkdtemp(join(directory, "run-"));
    const evidence = evidenceAt(workDir);
    await mkdir(evidence.rootDir, { recursive: true });
    const invocations: RiskDroidInvocation[] = [];
    const skills: string[] = [];
    const result = await runRiskJudge({
      judge: judgePlan().judge,
      snapshot,
      evidence,
      env: { PATH: "/usr/bin" },
      execute: async (invocation) => {
        invocations.push(invocation);
        skills.push(
          await readFile(
            join(evidence.rootDir, ".factory/skills/pr-risk-judge/SKILL.md"),
            "utf8",
          ),
        );
        return stdouts.shift() ?? "";
      },
    });
    return { result, invocations, skills, evidence };
  }

  it("runs the plan's skill with only the plan's tools, settings and timeout", async () => {
    const { result, invocations, skills, evidence } = await judgeWith([
      execSummary(JSON.stringify(answer)),
    ]);
    expect(result.verdict).toEqual(answer);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      sessionId: "session-1",
      valid: true,
    });
    expect(invocations).toHaveLength(1);
    const { args, cwd, env, timeoutMs } = invocations[0]!;
    expect(args).toEqual([
      "--settings",
      join(evidence.rootDir, "settings.json"),
      "exec",
      "--auto",
      "high",
      "--disable-builtin-skills",
      "--tag",
      "riskAssessment",
      "--only-tools",
      "Read,Grep,Execute",
      "--output-format",
      "json",
      "--cwd",
      evidence.rootDir,
      "/pr-risk-judge",
    ]);
    expect(cwd).toBe(evidence.rootDir);
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(timeoutMs).toBe(1_000_000);
    expect(
      JSON.parse(
        await readFile(join(evidence.rootDir, "settings.json"), "utf8"),
      ),
    ).toEqual({ model: "synthetic-model" });
    expect(skills[0]).toStartWith("# Judge\n\n{");
    expect(skills[0]).toContain('"title": "Tidy a helper"');
    expect(skills[0]).not.toContain("{{PR_SNAPSHOT_JSON}}");
  });

  it("retries once, strictly, naming the failed rules and the contract", async () => {
    const { result, invocations, skills } = await judgeWith([
      execSummary(JSON.stringify({ ...answer, extra: 1 })),
      execSummary(JSON.stringify(answer)),
    ]);
    expect(result.verdict).toEqual(answer);
    expect(invocations).toHaveLength(2);
    expect(result.attempts.map((attempt) => attempt.valid)).toEqual([
      false,
      true,
    ]);
    expect(result.attempts[0]).toMatchObject({
      invalidReason: "schema",
      invalidCodes: ["unrecognized_keys"],
      retryFeedback: ["<root>: unrecognized_keys"],
    });
    expect(skills[0]).not.toContain("## Strict retry");
    expect(skills[1]).toStartWith(skills[0]!.trimEnd());
    expect(skills[1]).toContain("## Strict retry");
    expect(skills[1]).toContain("- <root>: unrecognized_keys");
    expect(skills[1]).toContain(judgePlan().judge.contract);
  });

  it("stops after the retry and returns both attempts without a verdict", async () => {
    const { result, invocations } = await judgeWith([
      execSummary("no object"),
      execSummary("still no object"),
      execSummary(JSON.stringify(answer)),
    ]);
    expect(result.verdict).toBeUndefined();
    expect(invocations).toHaveLength(2);
    expect(result.attempts.map((attempt) => attempt.invalidReason)).toEqual([
      "no_json",
      "no_json",
    ]);
  });
});

describe("executeRiskDroid", () => {
  async function script(body: string) {
    const path = join(await mkdtemp(join(directory, "cli-")), "droid");
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o700);
    return path;
  }
  const invocation = (timeoutMs = 10_000): RiskDroidInvocation => ({
    args: ["exec"],
    cwd: directory,
    env: { PATH: "/usr/bin:/bin", ONLY: "this" },
    timeoutMs,
  });

  it("gives the session exactly the environment it was handed", async () => {
    process.env.RISK_TEST_INHERITED = "synthetic-inherited-value";
    try {
      const cli = await script("/usr/bin/env");
      const lines = (await executeRiskDroid(cli, invocation()))
        .trim()
        .split("\n")
        .filter((line) => !line.startsWith("PWD=") && !line.startsWith("_="))
        .sort();
      expect(lines).toEqual(["ONLY=this", "PATH=/usr/bin:/bin"]);
    } finally {
      delete process.env.RISK_TEST_INHERITED;
    }
  });

  it("returns the failure summary of a session that exits non-zero", async () => {
    const summary = execSummary("boom", true);
    const cli = await script(`printf '%s' '${summary}'; exit 3`);
    expect(await executeRiskDroid(cli, invocation())).toBe(summary);
  });

  it("reports a session that could not run without quoting what it printed", async () => {
    const cli = await script("echo synthetic-stderr-detail >&2; exit 7");
    const failure = await executeRiskDroid(cli, invocation()).catch(
      (error: unknown) => error,
    );
    expect((failure as Error).message).toBe(
      "The risk judge session could not run (exit 7, signal none)",
    );
  });

  it("reports a session that outlives its timeout as a timeout", async () => {
    const cli = await script("exec /bin/sleep 30");
    await expect(executeRiskDroid(cli, invocation(300))).rejects.toBeInstanceOf(
      RiskJudgeTimeoutError,
    );
  });
});
