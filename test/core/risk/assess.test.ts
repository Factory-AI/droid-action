import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessPullRequest } from "../../../src/core/risk/assess";
import { RiskError } from "../../../src/core/risk/types";
import {
  commit,
  createOriginAndCheckout,
  execSummary,
  git,
  judge,
  planFor,
  validVerdict,
} from "./fixtures";

describe("assessPullRequest", () => {
  let repoDir = "";
  let checkoutDir = "";
  let baseSha = "";
  let headSha = "";

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "pr-risk-assess-repo-"));
    checkoutDir = await createOriginAndCheckout(repoDir);
    await writeFile(join(checkoutDir, "app.ts"), "export const old = 1;\n");
    baseSha = await commit(checkoutDir, "base");
    await writeFile(join(checkoutDir, "app.ts"), "export const next = 1;\n");
    headSha = await commit(checkoutDir, "head");
    await git(
      checkoutDir,
      "push",
      "-q",
      "origin",
      `${baseSha}:refs/heads/dev`,
      `${headSha}:refs/pull/123/head`,
    );
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  const env = { PATH: process.env.PATH, FACTORY_API_KEY: "factory-key" };

  it("judges the planned head against the fetched evidence and removes the workspace", async () => {
    const seen: { cwd?: string; diff?: string; skill?: string } = {};

    const result = await assessPullRequest({
      plan: planFor({ baseSha, headSha }),
      repoDir: checkoutDir,
      githubToken: "read-token",
      env,
      executeDroid: async ({ cwd }) => {
        seen.cwd = cwd;
        seen.diff = await readFile(join(cwd, "evidence", "pr.diff"), "utf8");
        seen.skill = await readFile(
          join(cwd, ".factory", "skills", "pr-risk-judge", "SKILL.md"),
          "utf8",
        );
        return execSummary(validVerdict);
      },
    });

    expect(result).toEqual({
      status: "judged",
      baseSha,
      judgeSha256: judge.sha256,
      snapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      listedFiles: 1,
      attempts: [
        { sessionId: "session-1", valid: true, durationMs: expect.any(Number) },
      ],
      durationMs: expect.any(Number),
      verdict: validVerdict,
    });
    expect(seen.diff).toContain("+export const next = 1;");
    expect(seen.skill).toContain(`"headSha": "${headSha}"`);
    expect(seen.skill).not.toContain(baseSha);
    expect(
      await git(checkoutDir, "worktree", "list", "--porcelain"),
    ).not.toContain(seen.cwd ?? "unset");
  });

  it("lists and counts what the planned commits change, whatever the pull request reported when the run began", async () => {
    const seen: { inventory?: unknown; skill?: string } = {};

    const result = await assessPullRequest({
      // Counts GitHub gave for another comparison, as it does once a pull
      // request is pointed at a different base branch.
      plan: planFor({
        baseSha,
        headSha,
        pullRequest: {
          title: "Rotate sessions safely",
          additions: 900,
          deletions: 400,
          changedFiles: 40,
        },
      }),
      repoDir: checkoutDir,
      githubToken: "read-token",
      env,
      executeDroid: async ({ cwd }) => {
        seen.inventory = JSON.parse(
          await readFile(join(cwd, "evidence", "changed-files.json"), "utf8"),
        );
        seen.skill = await readFile(
          join(cwd, ".factory", "skills", "pr-risk-judge", "SKILL.md"),
          "utf8",
        );
        return execSummary(validVerdict);
      },
    });

    expect(result).toMatchObject({ status: "judged", listedFiles: 1 });
    expect(seen.inventory).toEqual({
      totals: { files: 1, additions: 1, deletions: 1 },
      files: [
        {
          filename: "app.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          kind: "runtime",
        },
      ],
    });
    expect(seen.skill).toContain(
      '"additions": 1,\n    "deletions": 1,\n    "changedFiles": 1\n',
    );
    expect(seen.skill).toContain('"unlistedFiles": 0,');
  });

  it("reports a judge that never produced a valid answer, with every attempt, and still removes the workspace", async () => {
    let cwd = "unset";

    const result = await assessPullRequest({
      plan: planFor({ baseSha, headSha }),
      repoDir: checkoutDir,
      githubToken: "read-token",
      env,
      executeDroid: async (input) => {
        cwd = input.cwd;
        return execSummary("I decline.");
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      reason: "invalid_pr_risk_verdict",
      attempts: [
        { valid: false, invalidReason: "no_json" },
        { valid: false, invalidReason: "no_json" },
      ],
    });
    expect(
      await git(checkoutDir, "worktree", "list", "--porcelain"),
    ).not.toContain(cwd);
  });

  it("fails without asking the judge when the planned head cannot be fetched", async () => {
    let asked = false;

    const result = await assessPullRequest({
      plan: planFor({ baseSha, headSha: "f".repeat(40) }),
      repoDir: checkoutDir,
      githubToken: "read-token",
      env,
      executeDroid: async () => {
        asked = true;
        return execSummary(validVerdict);
      },
    });

    expect(result).toEqual({
      status: "failed",
      reason: "evidence_git_failed",
      durationMs: expect.any(Number),
    });
    expect(asked).toBe(false);
  });

  describe("with credentials the checkout persisted", () => {
    const tokenKey = "http.https://github.com/.extraheader";
    const header = "AUTHORIZATION: basic d29ya2Zsb3ctdG9rZW4=";
    const unset = (key: string) =>
      git(checkoutDir, "config", "--unset-all", key).catch(() => undefined);

    afterEach(async () => {
      await unset(tokenKey);
      await unset("core.sshCommand");
    });

    it("removes the checkout's token before the judge runs anything", async () => {
      await git(checkoutDir, "config", tokenKey, header);
      const seen: string[] = [];

      const result = await assessPullRequest({
        plan: planFor({ baseSha, headSha }),
        repoDir: checkoutDir,
        githubToken: "read-token",
        env,
        executeDroid: async ({ cwd }) => {
          // What a command from the pull request could read, from the head
          // worktree and from the job's checkout.
          for (const dir of [join(cwd, "evidence", "head"), checkoutDir]) {
            seen.push(await git(dir, "config", "--list"));
          }
          return execSummary(validVerdict);
        },
      });

      expect(result).toMatchObject({ status: "judged" });
      expect(seen).toHaveLength(2);
      for (const config of seen) expect(config).not.toContain("extraheader");
    });

    it("fails without asking the judge when the checkout keeps an SSH key, and removes the workspace", async () => {
      await git(checkoutDir, "config", "core.sshCommand", "ssh -i /tmp/key");
      let asked = false;

      const result = await assessPullRequest({
        plan: planFor({ baseSha, headSha }),
        repoDir: checkoutDir,
        githubToken: "read-token",
        env,
        executeDroid: async () => {
          asked = true;
          return execSummary(validVerdict);
        },
      });

      expect(result).toEqual({
        status: "failed",
        reason: "checkout_credentials_persisted",
        durationMs: expect.any(Number),
      });
      expect(asked).toBe(false);
      expect(
        (await git(checkoutDir, "worktree", "list", "--porcelain")).match(
          /^worktree /gm,
        ),
      ).toHaveLength(1);
    });

    it("leaves them alone in a clone that is the caller's own", async () => {
      await git(checkoutDir, "config", tokenKey, header);
      await git(checkoutDir, "config", "core.sshCommand", "ssh -i /tmp/key");

      const result = await assessPullRequest({
        plan: planFor({ baseSha, headSha }),
        repoDir: checkoutDir,
        githubToken: "read-token",
        keepCheckoutCredentials: true,
        env,
        executeDroid: async () => execSummary(validVerdict),
      });

      expect(result).toMatchObject({ status: "judged" });
      expect(await git(checkoutDir, "config", tokenKey)).toBe(header);
      expect(await git(checkoutDir, "config", "core.sshCommand")).toBe(
        "ssh -i /tmp/key",
      );
    });
  });

  it("settles a run with no GitHub token as a failure rather than throwing", async () => {
    expect(
      await assessPullRequest({
        plan: planFor(),
        repoDir: checkoutDir,
        githubToken: undefined,
        env,
      }),
    ).toEqual({
      status: "failed",
      reason: "github_token_missing",
      durationMs: expect.any(Number),
    });
  });

  it("keeps a labelled failure's reason and files anything else as unexpected", async () => {
    const labelled = await assessPullRequest({
      plan: planFor({ baseSha, headSha }),
      repoDir: checkoutDir,
      githubToken: "read-token",
      env,
      executeDroid: async () => {
        throw new RiskError("judge_timeout", "PR risk judge timed out");
      },
    });
    expect(labelled).toMatchObject({
      status: "failed",
      reason: "judge_timeout",
    });

    const unlabelled = await assessPullRequest({
      plan: planFor({ baseSha, headSha }),
      repoDir: checkoutDir,
      githubToken: "read-token",
      env,
      executeDroid: async () => {
        throw new Error("boom");
      },
    });
    expect(unlabelled).toMatchObject({
      status: "failed",
      reason: "unexpected",
    });
  });
});
