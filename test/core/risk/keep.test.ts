import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { answerKeepOffer } from "../../../src/core/risk/keep";
import {
  RISK_BEGIN_MAX_BODY_BYTES,
  type RiskBeginRequest,
} from "../../../src/core/risk/types";
import { commit, createRepushedPullRequest, git } from "./fixtures";

const execFileAsync = promisify(execFile);

const request: RiskBeginRequest = {
  repo: "acme/app",
  pr: 123,
  manual: false,
  reviewOutcome: "success",
  run: { runner: "droid-action", dryRun: false },
};

/** `git diff` as a plain git prints it, untouched by the code under test. */
async function plainDiff(cwd: string, from: string, to: string) {
  const { stdout } = await execFileAsync("git", ["diff", from, to], {
    cwd,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return stdout;
}

async function withRepo<T>(run: (repoDir: string) => Promise<T>): Promise<T> {
  const repoDir = await mkdtemp(join(tmpdir(), "pr-risk-keep-repo-"));
  try {
    return await run(repoDir);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}

describe("answerKeepOffer", () => {
  it("answers with the diff between two heads the checkout never fetched, byte for byte", async () => {
    await withRepo(async (repoDir) => {
      const { authorDir, checkoutDir, scoredHeadSha, headSha } =
        await createRepushedPullRequest(repoDir);

      const answer = await answerKeepOffer(
        request,
        { action: "keep", headSha, scoredHeadSha },
        { repoDir: checkoutDir },
      );

      const diff = await plainDiff(authorDir, scoredHeadSha, headSha);
      // The last hunk line is a blank context line: one space. Losing it
      // would leave the hunk a line short of what its header declares.
      expect(diff.endsWith("+const b = 3;\n \n")).toBe(true);
      expect(answer).toEqual({
        ...request,
        keep: { changes: { headSha, scoredHeadSha, diff } },
      });
      expect(
        await git(checkoutDir, "rev-parse", "--is-shallow-repository"),
      ).toBe("false");
    });
  });

  it("reads the same diff from a shallow checkout", async () => {
    await withRepo(async (repoDir) => {
      const { authorDir, checkoutDir, scoredHeadSha, headSha } =
        await createRepushedPullRequest(repoDir, ["--depth=1"]);
      expect(
        await git(checkoutDir, "rev-parse", "--is-shallow-repository"),
      ).toBe("true");

      const answer = await answerKeepOffer(
        request,
        { action: "keep", headSha, scoredHeadSha },
        { repoDir: checkoutDir },
      );

      expect(answer.keep?.changes?.diff).toBe(
        await plainDiff(authorDir, scoredHeadSha, headSha),
      );
    });
  });

  it("answers without changes when a head cannot be fetched", async () => {
    await withRepo(async (repoDir) => {
      const { checkoutDir, headSha } = await createRepushedPullRequest(repoDir);

      const answer = await answerKeepOffer(
        request,
        { action: "keep", headSha, scoredHeadSha: "f".repeat(40) },
        { repoDir: checkoutDir },
      );

      expect(answer).toEqual(request);
    });
  });

  it("answers without changes when the diff fits until it is encoded into the request", async () => {
    await withRepo(async (repoDir) => {
      const { authorDir, checkoutDir, scoredHeadSha } =
        await createRepushedPullRequest(repoDir);
      // Each quote is one byte in the diff and two in the JSON body.
      await writeFile(
        join(authorDir, "app.ts"),
        `${'"'.repeat(Math.floor(RISK_BEGIN_MAX_BODY_BYTES * 0.75))}\n`,
      );
      const headSha = await commit(authorDir, "quotes");
      await git(
        authorDir,
        "push",
        "-q",
        "--force",
        "origin",
        `${headSha}:refs/pull/123/head`,
      );
      const diff = await plainDiff(authorDir, scoredHeadSha, headSha);
      expect(Buffer.byteLength(diff)).toBeLessThan(RISK_BEGIN_MAX_BODY_BYTES);

      const answer = await answerKeepOffer(
        request,
        { action: "keep", headSha, scoredHeadSha },
        { repoDir: checkoutDir },
      );

      expect(answer).toEqual(request);
    });
  });
});
