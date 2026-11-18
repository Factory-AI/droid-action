import { describe, expect, it, spyOn } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  fetchRiskRevisions,
  gitEnvironment,
  removeCheckoutCredentials,
} from "../../../src/core/risk/checkout";
import {
  checkoutWithPullRequest,
  commit,
  createOriginAndCheckout,
  git,
  incrementalFor,
} from "./fixtures";

const execFileAsync = promisify(execFile);

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

describe("removeCheckoutCredentials", () => {
  const tokenKey = "http.https://github.com/.extraheader";
  const basic = (token: string) =>
    Buffer.from(`x-access-token:${token}`).toString("base64");

  it("removes the token a checkout persisted, from its config or a file that config includes", async () => {
    const repoDir = await realpath(
      await mkdtemp(join(tmpdir(), "pr-risk-checkout-repo-")),
    );
    try {
      const { checkoutDir, originDir } = await checkoutWithPullRequest(repoDir);
      const gitDir = join(checkoutDir, ".git");
      // What actions/checkout wrote into the clone's config up to v5.
      await git(
        checkoutDir,
        "config",
        tokenKey,
        `AUTHORIZATION: basic ${basic("workflow-token")}`,
      );
      // What it writes since v6: the header in a file of its own, included
      // for the checkout.
      const credentialsFile = join(repoDir, "git-credentials.config");
      await git(
        checkoutDir,
        "config",
        "--file",
        credentialsFile,
        tokenKey,
        `AUTHORIZATION: basic ${basic("included-token")}`,
      );
      await git(
        checkoutDir,
        "config",
        `includeIf.gitdir:${gitDir}.path`,
        credentialsFile,
      );
      // Until it is removed, a command run in the checkout reads both.
      const before = await git(checkoutDir, "config", "--list");
      expect(before).toContain(basic("workflow-token"));
      expect(before).toContain(basic("included-token"));

      await removeCheckoutCredentials(checkoutDir);

      expect(await git(checkoutDir, "config", "--list")).not.toContain(
        "extraheader",
      );
      expect(await readFile(join(gitDir, "config"), "utf8")).not.toContain(
        basic("workflow-token"),
      );
      expect(await readFile(credentialsFile, "utf8")).not.toContain(
        basic("included-token"),
      );
      // Nothing else the checkout was configured with is touched.
      expect(await git(checkoutDir, "config", "remote.origin.url")).toBe(
        originDir,
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("removes the token from each submodule's config, however deeply it is nested", async () => {
    const repoDir = await realpath(
      await mkdtemp(join(tmpdir(), "pr-risk-checkout-repo-")),
    );
    try {
      const { checkoutDir, originDir } = await checkoutWithPullRequest(repoDir);
      await git(
        checkoutDir,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        originDir,
        "libs/sub",
      );
      const submoduleGitDir = join(checkoutDir, ".git", "modules", "libs/sub");
      // Where a submodule of that submodule keeps its git directory.
      const nestedGitDir = join(submoduleGitDir, "modules", "inner");
      await git(checkoutDir, "init", "-q", "--bare", nestedGitDir);
      for (const dir of [submoduleGitDir, nestedGitDir]) {
        await git(
          dir,
          "config",
          tokenKey,
          `AUTHORIZATION: basic ${basic("workflow-token")}`,
        );
        expect(await readFile(join(dir, "config"), "utf8")).toContain(
          basic("workflow-token"),
        );
      }
      // A workspace reused between runs can hold a submodule's git directory
      // after the submodule's files are gone.
      await rm(join(checkoutDir, "libs"), { recursive: true, force: true });

      await removeCheckoutCredentials(checkoutDir);

      for (const dir of [submoduleGitDir, nestedGitDir]) {
        expect(await readFile(join(dir, "config"), "utf8")).not.toContain(
          "extraheader",
        );
      }
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("refuses a checkout that keeps an SSH key, which it cannot take away", async () => {
    const repoDir = await realpath(
      await mkdtemp(join(tmpdir(), "pr-risk-checkout-repo-")),
    );
    try {
      const { checkoutDir } = await checkoutWithPullRequest(repoDir);
      // What actions/checkout persists for its `ssh-key` input.
      const sshCommand = `ssh -i "${join(repoDir, "deploy-key")}"`;
      await git(checkoutDir, "config", "core.sshCommand", sshCommand);

      const refusal = await removeCheckoutCredentials(checkoutDir).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(refusal).toMatchObject({
        reason: "checkout_credentials_persisted",
      });
      expect(String(refusal)).not.toContain("deploy-key");
      expect(await git(checkoutDir, "config", "core.sshCommand")).toBe(
        sshCommand,
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

describe("gitEnvironment", () => {
  const job = {
    PATH: process.env.PATH,
    HOME: "/home/runner",
    TMPDIR: "/tmp",
    FACTORY_API_KEY: "factory-key",
    GITHUB_TOKEN: "workflow-token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example",
    ACTIONS_RUNTIME_TOKEN: "runtime-token",
  };

  it("passes git nothing of the job but where to find programs and files", () => {
    expect(gitEnvironment(undefined, job)).toEqual({
      PATH: job.PATH,
      HOME: "/home/runner",
      TMPDIR: "/tmp",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
    });
  });

  it("replaces the Authorization header the checkout configured rather than adding a second", async () => {
    const seen: Array<string | null> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("authorization"));
        return new Response("not found", { status: 404 });
      },
    });
    const repoDir = await mkdtemp(join(tmpdir(), "pr-risk-checkout-repo-"));
    try {
      const serverUrl = `http://127.0.0.1:${server.port}`;
      await git(repoDir, "init", "-q");
      // What actions/checkout persists for the workflow token.
      await git(
        repoDir,
        "config",
        `http.${serverUrl}/.extraheader`,
        "AUTHORIZATION: basic d29ya2Zsb3c=",
      );

      await expect(
        execFileAsync("git", ["ls-remote", `${serverUrl}/acme/app.git`], {
          cwd: repoDir,
          env: gitEnvironment("read-token", job, serverUrl),
        }),
      ).rejects.toThrow();

      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen)).toEqual(
        new Set([
          `basic ${Buffer.from("x-access-token:read-token").toString("base64")}`,
        ]),
      );
    } finally {
      await server.stop(true);
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
