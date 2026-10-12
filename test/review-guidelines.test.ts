import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { parse } from "yaml";

const root = path.join(import.meta.dir, "..");
const actionDir = path.join(root, "review-guidelines");
const loadAction = (relativePath: string): any =>
  parse(readFileSync(path.join(actionDir, relativePath), "utf8"));
const learn = loadAction("action.yml");
const publish = loadAction("publish/action.yml");
const stepById = (action: any, id: string): any =>
  action.runs.steps.find((step: any) => step.id === id);

describe("review guidelines action wiring", () => {
  // The distill step reads untrusted review comments and can edit any file in
  // its job, so no token may be reachable there and publishing must happen in
  // a different job.
  it("keeps every GitHub token out of the learning job's steps", () => {
    expect(JSON.stringify(learn)).not.toContain("outputs.github_token");
    expect(JSON.stringify(stepById(learn, "distill").env)).not.toContain(
      "TOKEN",
    );
    const script = readFileSync(path.join(actionDir, "distill.sh"), "utf8");
    expect(script).toContain("-u ACTIONS_ID_TOKEN_REQUEST_TOKEN");
    expect(script).toContain("-u ACTIONS_ID_TOKEN_REQUEST_URL");
    expect(script).toContain("--only-tools Read,Grep,Glob,LS,Create,Edit");
  });

  it("hands the publish job only the staged result", () => {
    const upload = learn.runs.steps.at(-1);
    expect(upload.uses).toStartWith("actions/upload-artifact@");
    expect(upload.with.path).toBe(
      "${{ runner.temp }}/review-guidelines-result",
    );

    const download = publish.runs.steps[0];
    expect(download.uses).toStartWith("actions/download-artifact@");
    expect(download.with.name).toBe(upload.with.name);
    expect(stepById(publish, "publish").run).toContain("publish.sh");
  });
});

describe("get-token", () => {
  it("writes the token to GITHUB_TOKEN_FILE instead of a step output", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "get-token-"));
    try {
      const output = path.join(dir, "output");
      writeFileSync(output, "");
      const tokenFile = path.join(dir, "token");

      await $`bun run ${path.join(root, "src/entrypoints/get-token.ts")}`
        .env({
          ...process.env,
          OVERRIDE_GITHUB_TOKEN: "ghs_test",
          GITHUB_TOKEN_FILE: tokenFile,
          GITHUB_OUTPUT: output,
        })
        .quiet();

      expect(readFileSync(tokenFile, "utf8")).toBe("ghs_test");
      expect(readFileSync(output, "utf8")).not.toContain("ghs_test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("review guidelines scripts", () => {
  let dir: string;
  let repo: string;
  let remote: string;
  let bin: string;
  let work: string;
  let result: string;
  const git = (...args: string[]) => $`git ${args}`.cwd(repo).quiet();

  const run = (script: string, env: Record<string, string> = {}) =>
    $`bash ${path.join(actionDir, script)}`
      .cwd(repo)
      .env({
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        GITHUB_REPOSITORY: "acme/web",
        ACTION_ROOT: root,
        ...env,
      })
      .nothrow()
      .quiet();

  const stub = (name: string, body: string) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  };

  /** A `bun` that stands in for get-token.ts, issuing `token` (or none). */
  const stubToken = (token: string) =>
    stub(
      "bun",
      token ? `printf '%s' '${token}' > "$GITHUB_TOKEN_FILE"` : "exit 0",
    );

  const writeGuidelines = (body: string) => {
    const target = path.join(repo, ".factory/skills/review-guidelines");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "SKILL.md"), body);
  };

  const writeResult = (files: Record<string, string>) => {
    mkdirSync(result, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(path.join(result, name), body);
    }
  };

  const remoteHeads = async () =>
    (await $`git ls-remote --heads ${remote}`.quiet().text()).trim();

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "review-guidelines-"));
    repo = path.join(dir, "repo");
    remote = path.join(dir, "remote.git");
    bin = path.join(dir, "bin");
    work = path.join(dir, "review-guidelines");
    result = path.join(dir, "review-guidelines-result");
    for (const d of [repo, bin, path.join(work, "out")]) {
      mkdirSync(d, { recursive: true });
    }
    await $`git init -q --bare ${remote}`.quiet();
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "test");
    await git("remote", "add", "origin", remote);
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "init");
    // Records every call and reports no open PR.
    stub("gh", `echo "$*" >> "${path.join(dir, "gh-calls")}"`);
    stubToken("ghs_test");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("mine.sh", () => {
    beforeEach(() => {
      writeFileSync(
        path.join(work, "mine.py"),
        `import json, os, sys\nopen(${JSON.stringify(path.join(dir, "args.json"))}, "w").write(json.dumps({"args": sys.argv[1:], "token": os.environ.get("GH_TOKEN")}))\n`,
      );
    });

    it("passes its own token, the backlog and the humans-only choice to the miner", async () => {
      writeGuidelines(
        "Unread backlog: 2026-01-01..2026-02-01\nUnread backlog: 2026-03-01..2026-03-15\n",
      );

      const outcome = await run("mine.sh", { INCLUDE_BOT_COMMENTS: "false" });

      expect(outcome.exitCode).toBe(0);
      expect(
        JSON.parse(readFileSync(path.join(dir, "args.json"), "utf8")),
      ).toEqual({
        args: [
          "--repo",
          "acme/web",
          "--out",
          path.join(work, "out"),
          "--backlog",
          "2026-01-01..2026-02-01",
          "--backlog",
          "2026-03-01..2026-03-15",
          "--humans-only",
        ],
        token: "ghs_test",
      });
    });

    it("stops without mining when no token was issued", async () => {
      stubToken("");

      const outcome = await run("mine.sh");

      expect(outcome.exitCode).toBe(0);
      expect(existsSync(path.join(dir, "args.json"))).toBe(false);
    });
  });

  describe("stage.sh", () => {
    it("stages only the guidelines files and the PR description", async () => {
      writeFileSync(path.join(work, "pr-body.md"), "New guidelines\n");
      writeFileSync(path.join(work, "open-pr"), "");
      writeGuidelines("- Prefer early returns.\n");
      writeFileSync(path.join(repo, "other.txt"), "not published\n");

      expect((await run("stage.sh")).exitCode).toBe(0);

      expect(
        (await $`ls -A ${result}`.quiet().text()).trim().split("\n").sort(),
      ).toEqual(["SKILL.md", "open-pr", "pr-body.md", "status"]);
      expect(readFileSync(path.join(result, "status"), "utf8").trim()).toBe(
        "update",
      );
    });

    it("marks the result empty when there is nothing to publish", async () => {
      expect((await run("stage.sh")).exitCode).toBe(0);
      expect(readFileSync(path.join(result, "status"), "utf8").trim()).toBe(
        "none",
      );
    });
  });

  describe("publish.sh", () => {
    it("pushes the guidelines branch and opens a PR", async () => {
      writeResult({
        status: "update\n",
        "pr-body.md": "New guidelines\n",
        "SKILL.md": "- Prefer early returns.\n",
      });

      const outcome = await run("publish.sh", { FACTORY_API_KEY: "fk-test" });

      expect(outcome.exitCode).toBe(0);
      expect(await remoteHeads()).toContain(
        "refs/heads/droid/review-guidelines",
      );
      expect(
        await $`git show droid/review-guidelines:.factory/skills/review-guidelines/SKILL.md`
          .cwd(remote)
          .quiet()
          .text(),
      ).toBe("- Prefer early returns.\n");
      expect(readFileSync(path.join(dir, "gh-calls"), "utf8")).toContain(
        "pr create --head droid/review-guidelines",
      );
    });

    it("refuses guidelines that contain a credential", async () => {
      writeResult({
        status: "update\n",
        "pr-body.md": "New guidelines\n",
        "SKILL.md": `Use ghp_${"a".repeat(30)} for access\n`,
      });

      const outcome = await run("publish.sh");

      expect(outcome.exitCode).toBe(1);
      expect(outcome.stdout.toString()).toContain("contain a credential");
      expect(await remoteHeads()).toBe("");
      expect(existsSync(path.join(dir, "gh-calls"))).toBe(false);
    });

    it("refuses a PR description that contains the Factory API key", async () => {
      writeResult({
        status: "update\n",
        "pr-body.md": "Key: fk-secret-value\n",
        "SKILL.md": "- Prefer early returns.\n",
      });

      const outcome = await run("publish.sh", {
        FACTORY_API_KEY: "fk-secret-value",
      });

      expect(outcome.exitCode).toBe(1);
      expect(await remoteHeads()).toBe("");
    });

    it("refuses a result with files it does not publish", async () => {
      writeResult({
        status: "update\n",
        "pr-body.md": "New guidelines\n",
        config: "[credential]\n\thelper = !steal\n",
      });

      const outcome = await run("publish.sh");

      expect(outcome.exitCode).toBe(1);
      expect(outcome.stdout.toString()).toContain("unexpected file (config)");
      expect(await remoteHeads()).toBe("");
    });

    it("refuses a guidelines file that is a symlink", async () => {
      writeResult({ status: "update\n", "pr-body.md": "New guidelines\n" });
      symlinkSync("/etc/hosts", path.join(result, "SKILL.md"));

      const outcome = await run("publish.sh");

      expect(outcome.exitCode).toBe(1);
      expect(outcome.stdout.toString()).toContain("other than a regular file");
      expect(await remoteHeads()).toBe("");
    });

    it("publishes nothing when the learning job found no update", async () => {
      writeResult({ status: "none\n" });

      const outcome = await run("publish.sh");

      expect(outcome.exitCode).toBe(0);
      expect(await remoteHeads()).toBe("");
      expect(existsSync(path.join(dir, "gh-calls"))).toBe(false);
    });
  });
});
