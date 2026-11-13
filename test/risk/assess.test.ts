import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  assessRisk,
  resolveRiskCli,
  type RiskAssessDependencies,
  type RiskAssessInput,
} from "../../src/risk/assess";
import { readRiskHandoff, writeRiskHandoff } from "../../src/risk/handoff";
import type { RiskDroidInvocation } from "../../src/risk/judge";
import { evidenceAt, execSummary, judgePlan, sha } from "./fixtures";

const answer = {
  verdict: true,
  brief: "Small and contained.",
  details: "Touches one helper.",
  scores: { blastRadius: 2 },
};
const CLI_SHA = "1".repeat(64);

let directory: string;
beforeAll(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "risk-assess-")));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

type Scenario = {
  input?: Partial<RiskAssessInput>;
  liveHeadSha?: string;
  judgeStdout?: string[];
  cliShaAfter?: string;
  failRevokeOf?: string;
};
async function assess(scenario: Scenario = {}) {
  const events: string[] = [];
  const invocations: RiskDroidInvocation[] = [];
  const workDir = await mkdtemp(join(directory, "work-"));
  const evidence = evidenceAt(workDir);
  await mkdir(evidence.rootDir, { recursive: true });
  const stdouts = scenario.judgeStdout ?? [execSummary(JSON.stringify(answer))];
  const dependencies: RiskAssessDependencies = {
    revokeToken: async (token) => {
      events.push(`revoke:${token}`);
      if (token === scenario.failRevokeOf) throw new Error("revoke refused");
    },
    mintJudgeToken: async () => {
      events.push("mint");
      return "judge-token";
    },
    fetchPullRequest: async ({ token }) => {
      events.push(`fetch:${token}`);
      return {
        title: "Change a",
        headSha: scenario.liveHeadSha ?? sha("a"),
        additions: 1,
        deletions: 1,
        changedFiles: 3,
        files: [
          {
            filename: "src/a.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
          },
        ],
      };
    },
    createEvidence: async (snapshot, options) => {
      events.push(
        `evidence:${snapshot.pullRequest.headSha}:${options.auth?.token}:${options.remoteUrl}`,
      );
      return evidence;
    },
    removeEvidence: async (path) => {
      events.push(`remove:${path === workDir}`);
    },
    execute: async (cliPath, invocation) => {
      events.push(`execute:${cliPath}:${invocation.args[0]}`);
      invocations.push(invocation);
      if (invocation.args[0] === "--version") return "droid 9.9.9\nextra\n";
      return stdouts.shift() ?? "";
    },
    hashFile: async () => {
      events.push("hash");
      return scenario.cliShaAfter ?? CLI_SHA;
    },
  };
  const result = await assessRisk(
    {
      plan: judgePlan(),
      repo: "acme/widgets",
      pr: 7,
      cli: { path: "/frozen/droid", sha256: CLI_SHA },
      reviewToken: "review-token",
      apiUrl: "https://github.example/api",
      serverUrl: "https://github.example",
      parentDir: directory,
      judgePath: "/usr/bin:/bin",
      factoryApiKey: "synthetic-factory-key",
      ...scenario.input,
    },
    dependencies,
  ).catch((error: unknown) => error);
  return { result, events, invocations, evidence };
}

describe("assessRisk", () => {
  it("revokes the review token, then judges with a token minted for it, then cleans up", async () => {
    const { result, events, invocations, evidence } = await assess();
    expect(events).toEqual([
      "revoke:review-token",
      "mint",
      "fetch:judge-token",
      `evidence:${sha("a")}:judge-token:https://github.example/acme/widgets.git`,
      "execute:/frozen/droid:--version",
      "execute:/frozen/droid:--settings",
      "hash",
      "remove:true",
      "revoke:judge-token",
    ]);
    // The session's whole environment: one GitHub credential, the read-only
    // one, and nothing the job or the review phase held.
    for (const { env } of invocations) {
      expect(Object.keys(env).sort()).toEqual([
        "DROID_EXEC_RUN_TYPE",
        "FACTORY_API_KEY",
        "FACTORY_DROID_AUTO_UPDATE_ENABLED",
        "GH_REPO",
        "GH_TOKEN",
        "HOME",
        "PATH",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
      ]);
      expect(env.GH_TOKEN).toBe("judge-token");
      expect(env.HOME).toBe(evidence.homeDir);
      expect(JSON.stringify(env)).not.toContain("review-token");
    }
    expect(result).toMatchObject({
      status: "assessed",
      droidCliVersion: "droid 9.9.9",
      rawAssessment: {
        headSha: sha("a"),
        baseSha: sha("b"),
        snapshotHash: evidence.snapshotHash,
        assignment: judgePlan().assignment,
        skillSha256: judgePlan().judge.skillSha256,
        unlistedFiles: 2,
        verdict: answer,
      },
    });
    const { rawAssessment } = result as {
      rawAssessment: { attempts: unknown[]; assessedAt: string };
    };
    expect(rawAssessment.attempts).toHaveLength(1);
    expect(Number.isNaN(Date.parse(rawAssessment.assessedAt))).toBe(false);
  });

  it("judges nothing when the review token cannot be revoked", async () => {
    const { result, events } = await assess({ failRevokeOf: "review-token" });
    expect((result as Error).message).toBe("revoke refused");
    expect(events).toEqual(["revoke:review-token"]);
  });

  it("mints without revoking when the review phase left no token", async () => {
    const { events } = await assess({ input: { reviewToken: undefined } });
    expect(events.slice(0, 2)).toEqual(["mint", "fetch:judge-token"]);
    expect(events.at(-1)).toBe("revoke:judge-token");
  });

  it("uses a caller-provided token as it is, and neither mints nor revokes", async () => {
    const { result, events, invocations } = await assess({
      input: { overrideToken: "caller-token" },
    });
    expect((result as { status: string }).status).toBe("assessed");
    expect(events.filter((event) => /^(mint|revoke)/u.test(event))).toEqual([]);
    expect(events[0]).toBe("fetch:caller-token");
    expect(invocations.at(-1)!.env.GH_TOKEN).toBe("caller-token");
  });

  it("does not judge a pull request that moved past the planned head", async () => {
    const { result, events } = await assess({ liveHeadSha: sha("9") });
    expect(result).toEqual({ status: "stale_head" });
    expect(events).toEqual([
      "revoke:review-token",
      "mint",
      "fetch:judge-token",
      "revoke:judge-token",
    ]);
  });

  it("discards the answer of an executable that changed while the judge ran", async () => {
    const { result, events } = await assess({ cliShaAfter: "2".repeat(64) });
    expect((result as Error).message).toBe(
      "The Droid executable changed while the judge ran",
    );
    expect(events.slice(-3)).toEqual([
      "hash",
      "remove:true",
      "revoke:judge-token",
    ]);
  });

  it("reports no verdict after two answers outside the shape", async () => {
    const { result, events } = await assess({
      judgeStdout: [execSummary("no object"), execSummary("no object")],
    });
    expect(result).toEqual({ status: "no_verdict" });
    expect(
      events.filter((event) => event === "execute:/frozen/droid:--settings"),
    ).toHaveLength(2);
    expect(events.at(-1)).toBe("revoke:judge-token");
  });

  it("keeps the result when the judge token cannot be revoked afterwards", async () => {
    const { result } = await assess({ failRevokeOf: "judge-token" });
    expect((result as { status: string }).status).toBe("assessed");
  });
});

describe("resolveRiskCli", () => {
  const digest = (content: string) =>
    createHash("sha256").update(content).digest("hex");
  async function executable(content: string) {
    const path = join(await mkdtemp(join(directory, "cli-")), "droid");
    await writeFile(path, content);
    await chmod(path, 0o700);
    return path;
  }

  it("accepts only the exact bytes the review phase froze", async () => {
    const path = await executable("frozen bytes");
    expect(
      await resolveRiskCli({
        RISK_CLI_PATH: path,
        RISK_CLI_SHA256: digest("frozen bytes"),
        // Ignored once a frozen executable is named.
        INPUT_PATH_TO_DROID_EXECUTABLE: "/somewhere/else",
      }),
    ).toEqual({ path, sha256: digest("frozen bytes") });
    await writeFile(path, "other bytes");
    await expect(
      resolveRiskCli({
        RISK_CLI_PATH: path,
        RISK_CLI_SHA256: digest("frozen bytes"),
      }),
    ).rejects.toThrow("changed after it was frozen");
  });

  it("refuses a frozen path that is a symlink, relative, or without a digest", async () => {
    const path = await executable("frozen bytes");
    const link = join(directory, "linked-droid");
    await symlink(path, link);
    await expect(
      resolveRiskCli({
        RISK_CLI_PATH: link,
        RISK_CLI_SHA256: digest("frozen bytes"),
      }),
    ).rejects.toThrow("not a regular file");
    for (const env of [
      { RISK_CLI_PATH: "droid", RISK_CLI_SHA256: digest("frozen bytes") },
      { RISK_CLI_PATH: path },
    ])
      await expect(resolveRiskCli(env)).rejects.toThrow("not usable");
  });

  it("pins the installed executable when no review session froze one", async () => {
    const home = await mkdtemp(join(directory, "home-"));
    await mkdir(join(home, ".local/bin"), { recursive: true });
    await writeFile(join(home, ".local/bin/droid"), "installed bytes");
    expect(await resolveRiskCli({ RUNNER_HOME: home })).toEqual({
      path: join(home, ".local/bin/droid"),
      sha256: digest("installed bytes"),
    });
    const custom = await executable("custom bytes");
    expect(
      await resolveRiskCli({
        RUNNER_HOME: home,
        INPUT_PATH_TO_DROID_EXECUTABLE: custom,
      }),
    ).toEqual({ path: custom, sha256: digest("custom bytes") });
    await expect(resolveRiskCli({})).rejects.toThrow(
      "Could not locate the Droid executable",
    );
  });
});

describe("risk handoff", () => {
  it("reads back exactly what was written and refuses anything else", async () => {
    const dir = await mkdtemp(join(directory, "handoff-"));
    const handoff = await writeRiskHandoff(dir, "plan.json", judgePlan());
    expect(await readRiskHandoff(handoff.path, handoff.sha256)).toEqual(
      judgePlan(),
    );
    await writeFile(
      handoff.path,
      JSON.stringify({ ...judgePlan(), headSha: sha("9") }),
    );
    await expect(readRiskHandoff(handoff.path, handoff.sha256)).rejects.toThrow(
      "changed after it was written",
    );
    for (const [path, digest] of [
      [undefined, handoff.sha256],
      [handoff.path, undefined],
      [handoff.path, "not-a-digest"],
    ])
      await expect(readRiskHandoff(path, digest)).rejects.toThrow(
        "handoff is missing",
      );
  });
});
