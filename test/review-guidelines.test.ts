import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { parse } from "yaml";

const root = path.join(import.meta.dir, "..");
const actionDir = path.join(root, "review-guidelines");
const action: any = parse(
  readFileSync(path.join(actionDir, "action.yml"), "utf8"),
);
const stepById = (id: string): any =>
  action.runs.steps.find((step: any) => step.id === id);

describe("review guidelines action wiring", () => {
  // The distill step reads untrusted review comments and edits files, so it
  // must never hold a GitHub credential; only mining and publishing may.
  it("withholds the GitHub token from the distill step", () => {
    const distill = stepById("distill");
    expect(JSON.stringify(distill.env ?? {})).not.toContain("token");
    const script = readFileSync(path.join(actionDir, "distill.sh"), "utf8");
    expect(script).toContain("-u ACTIONS_ID_TOKEN_REQUEST_TOKEN");
    expect(script).toContain("-u ACTIONS_ID_TOKEN_REQUEST_URL");
    expect(script).toContain("--only-tools Read,Grep,Glob,LS,Create,Edit");
  });

  it("hands each writing step the token from its own exchange", () => {
    expect(stepById("mine").env.GH_TOKEN).toContain(
      "steps.mining_token.outputs.github_token",
    );
    expect(stepById("publish").env.GH_TOKEN).toContain(
      "steps.publish_token.outputs.github_token",
    );
  });

  it("stops after the token step when no token was issued", () => {
    for (const id of ["mine", "distill", "publish_token"]) {
      expect(stepById(id).if).toBe(
        "steps.mining_token.outputs.github_token != ''",
      );
    }
    expect(stepById("publish").if).toBe(
      "steps.publish_token.outputs.github_token != ''",
    );
  });
});

describe("review guidelines scripts", () => {
  let dir: string;
  let repo: string;
  let remote: string;
  let bin: string;
  let work: string;
  const git = (...args: string[]) => $`git ${args}`.cwd(repo).quiet();

  const run = (script: string, env: Record<string, string> = {}) =>
    $`bash ${path.join(actionDir, script)}`
      .cwd(repo)
      .env({
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        GITHUB_REPOSITORY: "acme/web",
        ...env,
      })
      .nothrow()
      .quiet();

  /** A `gh` that reports no open PR and records every call. */
  const stubGh = () => {
    const gh = path.join(bin, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash\necho "$*" >> "${path.join(dir, "gh-calls")}"\n`,
    );
    chmodSync(gh, 0o755);
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "review-guidelines-"));
    repo = path.join(dir, "repo");
    remote = path.join(dir, "remote.git");
    bin = path.join(dir, "bin");
    work = path.join(dir, "review-guidelines");
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
    stubGh();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeGuidelines = (body: string) => {
    const target = path.join(repo, ".factory/skills/review-guidelines");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "SKILL.md"), body);
  };

  it("passes the backlog and the humans-only choice to the miner", async () => {
    writeFileSync(
      path.join(work, "mine.py"),
      `import json, sys\nopen(${JSON.stringify(path.join(dir, "args.json"))}, "w").write(json.dumps(sys.argv[1:]))\n`,
    );
    writeGuidelines(
      "Unread backlog: 2026-01-01..2026-02-01\nUnread backlog: 2026-03-01..2026-03-15\n",
    );

    const result = await run("mine.sh", { INCLUDE_BOT_COMMENTS: "false" });

    expect(result.exitCode).toBe(0);
    expect(
      JSON.parse(readFileSync(path.join(dir, "args.json"), "utf8")),
    ).toEqual([
      "--repo",
      "acme/web",
      "--out",
      path.join(work, "out"),
      "--backlog",
      "2026-01-01..2026-02-01",
      "--backlog",
      "2026-03-01..2026-03-15",
      "--humans-only",
    ]);
  });

  it("refuses to publish guidelines that contain a credential", async () => {
    writeFileSync(path.join(work, "pr-body.md"), "New guidelines\n");
    writeGuidelines(`Use ghp_${"a".repeat(30)} for access\n`);

    const result = await run("publish.sh");

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("contain a credential");
    expect(
      (await $`git ls-remote --heads ${remote}`.quiet().text()).trim(),
    ).toBe("");
    expect(existsSync(path.join(dir, "gh-calls"))).toBe(false);
  });

  it("pushes the guidelines branch and opens a PR", async () => {
    writeFileSync(path.join(work, "pr-body.md"), "New guidelines\n");
    writeGuidelines("- Prefer early returns.\n");

    const result = await run("publish.sh", { FACTORY_API_KEY: "fk-test" });

    expect(result.exitCode).toBe(0);
    expect(await $`git ls-remote --heads ${remote}`.quiet().text()).toContain(
      "refs/heads/droid/review-guidelines",
    );
    expect(readFileSync(path.join(dir, "gh-calls"), "utf8")).toContain(
      "pr create --head droid/review-guidelines",
    );
  });
});
