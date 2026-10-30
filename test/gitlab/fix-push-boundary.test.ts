import { describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pushFixCommit } from "../../src/gitlab/operations/commands";

describe("GitLab push boundary credentials and owned cleanup", () => {
  for (const failAt of ["precedence", "", "init", "fetch", "push"])
    it(`removes only its bare directory after ${failAt || "success"}`, async () => {
      const saved = {
        GITLAB_TOKEN: process.env.GITLAB_TOKEN,
        OVERRIDE_GITLAB_TOKEN: process.env.OVERRIDE_GITLAB_TOKEN,
        CI_SERVER_URL: process.env.CI_SERVER_URL,
        TMPDIR: process.env.TMPDIR,
      };
      const parent = await fs.mkdtemp(
        path.join(os.tmpdir(), "droid-owned-push-test-"),
      );
      Object.assign(process.env, {
        GITLAB_TOKEN: "fake-primary-token",
        CI_SERVER_URL: "https://127.0.0.1:9",
        TMPDIR: parent,
      });
      if (failAt === "precedence")
        process.env.OVERRIDE_GITLAB_TOKEN = "fake-override-token";
      else delete process.env.OVERRIDE_GITLAB_TOKEN;
      let owned = "";
      let primaryUsed = false;
      const commands: string[][] = [];
      const spawn = spyOn(childProcess, "spawnSync").mockImplementation(((
        _command: string,
        args: string[],
        options: { cwd: string; env: NodeJS.ProcessEnv },
      ) => {
        owned = options.cwd;
        commands.push(args);
        primaryUsed =
          options.env.GIT_CONFIG_VALUE_0 ===
          `Authorization: Basic ${Buffer.from("oauth2:fake-primary-token").toString("base64")}`;
        return {
          pid: 0,
          output: [],
          stdout: "",
          stderr: "",
          status: args[0] === failAt ? 1 : 0,
          signal: null,
        };
      }) as never);
      try {
        const result = pushFixCommit({
          projectUrl: "https://127.0.0.1:9/group/project",
          branch: "feat/retry",
          temporaryBranch: "droid/fix-owned",
          sha: "a".repeat(40),
        });
        if (failAt && failAt !== "precedence")
          await expect(result).rejects.toThrow("Non-force");
        else await result;
        expect(spawn).toHaveBeenCalled();
        expect(primaryUsed).toBe(true);
        expect(
          owned.startsWith(path.join(os.tmpdir(), "droid-gitlab-publish-")),
        ).toBe(true);
        await expect(fs.stat(owned)).rejects.toThrow();
        expect(commands.flat().some((arg) => arg.includes("--force"))).toBe(
          false,
        );
      } finally {
        spawn.mockRestore();
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        if (owned.startsWith(path.join(os.tmpdir(), "droid-gitlab-publish-")))
          await fs.rm(owned, { recursive: true, force: true });
        await fs.rm(parent, { recursive: true, force: true });
      }
    });
});
