import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  gitEnvironment,
  removeCheckoutCredentials,
} from "../../../src/core/worker/checkout";
import { checkoutWithPullRequest, git } from "./fixtures";

const execFileAsync = promisify(execFile);

describe("removeCheckoutCredentials", () => {
  const tokenKey = "http.https://github.com/.extraheader";
  const basic = (token: string) =>
    Buffer.from(`x-access-token:${token}`).toString("base64");

  it("removes the token a checkout persisted, from its config or a file that config includes", async () => {
    const repoDir = await realpath(
      await mkdtemp(join(tmpdir(), "droid-worker-checkout-repo-")),
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
      await mkdtemp(join(tmpdir(), "droid-worker-checkout-repo-")),
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
      await mkdtemp(join(tmpdir(), "droid-worker-checkout-repo-")),
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
    const repoDir = await mkdtemp(
      join(tmpdir(), "droid-worker-checkout-repo-"),
    );
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
