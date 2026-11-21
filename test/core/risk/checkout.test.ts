import { describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchRiskRevisions } from "../../../src/core/risk/checkout";
import {
  checkoutWithPullRequest,
  commit,
  createOriginAndCheckout,
  git,
} from "../worker/fixtures";
import { incrementalFor } from "./fixtures";

describe("fetchRiskRevisions", () => {
  /**
   * What actions/checkout leaves by default: the pull request's head and
   * nothing behind it.
   */
  async function shallowCheckout(repoDir: string, originDir: string) {
    const shallowDir = join(repoDir, "shallow");
    await git(repoDir, "init", "-q", shallowDir);
    await git(shallowDir, "remote", "add", "origin", `file://${originDir}`);
    await git(
      shallowDir,
      "fetch",
      "-q",
      "--depth",
      "1",
      "origin",
      "refs/pull/123/head",
    );
    return shallowDir;
  }

  it("brings the base, the head and the default branch's tip into a one-commit-deep checkout, with the history behind them", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "pr-risk-checkout-repo-"));
    try {
      const { originDir, forkSha, headSha, baseSha, policySha } =
        await checkoutWithPullRequest(repoDir);
      const shallowDir = await shallowCheckout(repoDir, originDir);
      expect(
        await git(shallowDir, "rev-parse", "--is-shallow-repository"),
      ).toBe("true");

      const policy = await fetchRiskRevisions(
        { pr: 123, baseSha },
        { repoDir: shallowDir, githubToken: "test-token" },
      );

      // The default branch's tip, not the pull request's base.
      expect(policy).toBe(policySha);
      // Only found when the history behind both commits was fetched.
      expect(await git(shallowDir, "merge-base", baseSha, headSha)).toBe(
        forkSha,
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("brings the two commits of an earlier verdict to re-check, and goes on without them when the remote has lost one", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const repoDir = await mkdtemp(join(tmpdir(), "pr-risk-checkout-repo-"));
    try {
      const { originDir, baseSha, policySha, priorHeadSha, priorBaseSha } =
        await checkoutWithPullRequest(repoDir);
      const shallowDir = await shallowCheckout(repoDir, originDir);
      const repo = { repoDir: shallowDir, githubToken: "test-token" };

      await fetchRiskRevisions(
        {
          pr: 123,
          baseSha,
          incremental: incrementalFor({ priorHeadSha, priorBaseSha }),
        },
        repo,
      );

      for (const sha of [priorHeadSha, priorBaseSha]) {
        expect(await git(shallowDir, "cat-file", "-t", sha)).toBe("commit");
      }
      expect(warn).not.toHaveBeenCalled();

      expect(
        await fetchRiskRevisions(
          {
            pr: 123,
            baseSha,
            incremental: incrementalFor({ priorBaseSha }),
          },
          repo,
        ),
      ).toBe(policySha);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "The earlier verdict's commits could not be fetched",
        ),
      );
    } finally {
      warn.mockRestore();
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("brings the pull request's head into a checkout that already has its whole history", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "pr-risk-checkout-repo-"));
    try {
      const { originDir, headSha, baseSha } =
        await checkoutWithPullRequest(repoDir);
      // A clone takes the branches, and a pull request's head is not one.
      const fullDir = join(repoDir, "full");
      await git(repoDir, "clone", "-q", `file://${originDir}`, fullDir);
      await expect(git(fullDir, "cat-file", "-t", headSha)).rejects.toThrow();

      await fetchRiskRevisions(
        { pr: 123, baseSha },
        { repoDir: fullDir, githubToken: "test-token" },
      );

      expect(await git(fullDir, "cat-file", "-t", headSha)).toBe("commit");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("fails instead of dropping the guidelines when the default branch cannot be resolved", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "pr-risk-checkout-repo-"));
    try {
      // The remote's HEAD names a branch that does not exist.
      const checkoutDir = await createOriginAndCheckout(repoDir, "missing");
      await writeFile(join(checkoutDir, "app.ts"), "export const old = 1;\n");
      const baseSha = await commit(checkoutDir, "base");
      await git(
        checkoutDir,
        "push",
        "-q",
        "origin",
        `${baseSha}:refs/heads/dev`,
        `${baseSha}:refs/pull/123/head`,
      );

      await expect(
        fetchRiskRevisions(
          { pr: 123, baseSha },
          { repoDir: checkoutDir, githubToken: "test-token" },
        ),
      ).rejects.toMatchObject({ reason: "pr_risk_default_branch_unresolved" });
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
