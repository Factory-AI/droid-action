import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const helper = path.resolve(import.meta.dir, "../../gitlab/freeze-runtime.sh");
const entries = [
  "gitlab-prepare",
  "gitlab-prepare-validator",
  "gitlab-post-review",
  "gitlab-collect-debug-artifacts",
  "gitlab-update-comment-link",
];
let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "droid-gl-frozen-"));
  await fs.mkdir(path.join(directory, "bin"));
  await fs.mkdir(path.join(directory, "action/src/entrypoints"), {
    recursive: true,
  });
  await fs.symlink(process.execPath, path.join(directory, "bin/bun"));
  await fs.writeFile(
    path.join(directory, "bin/droid"),
    "#!/bin/sh\necho trusted-cli\n",
    { mode: 0o755 },
  );
  for (const entry of entries)
    await fs.writeFile(
      path.join(directory, `action/src/entrypoints/${entry}.ts`),
      `console.log(${JSON.stringify(entry)}); if (process.env.FINALIZER_FAIL === "true" && ${JSON.stringify(entry)}.includes("update-comment")) process.exit(9);\n`,
    );
  await fs.writeFile(
    path.join(directory, "bunfig.toml"),
    'preload = ["./evil.ts"]\n',
  );
  await fs.writeFile(
    path.join(directory, "evil.ts"),
    `require("fs").writeFileSync(${JSON.stringify(path.join(directory, "pwned"))}, "secret");\n`,
  );
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

async function run(command: string) {
  const child = Bun.spawn(
    [
      "bash",
      "-c",
      `set -euo pipefail; . ${JSON.stringify(helper)}; droid_freeze_runtime; ${command}`,
    ],
    {
      cwd: directory,
      env: {
        PATH: `${directory}/bin:/usr/bin:/bin`,
        HOME: directory,
        CI_PROJECT_DIR: directory,
        DROID_ACTION_DIR: path.join(directory, "action"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("GitLab frozen privileged runtime", () => {
  it("builds and invokes real isolated bundles rather than loading checkout config", async () => {
    const result = await run("droid_run_trusted gitlab-post-review");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gitlab-post-review");
    expect(await fs.exists(path.join(directory, "pwned"))).toBe(false);
  });

  it("does not reload source changed after the model starts", async () => {
    const result = await run(
      'printf "console.log(\\\"attacker-source\\\");" > "$DROID_ACTION_DIR/src/entrypoints/gitlab-post-review.ts"; droid_run_trusted gitlab-post-review',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gitlab-post-review");
    expect(result.stdout).not.toContain("attacker-source");
  });

  it("refuses a changed frozen publishing bundle", async () => {
    const result = await run(
      'printf "console.log(\\\"attacker-bundle\\\");" > "$DROID_FROZEN_DIR/gitlab-post-review.js"; droid_run_trusted gitlab-post-review',
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("integrity");
    expect(result.stdout).not.toContain("attacker-bundle");
  });

  it("refuses a changed CLI executable before either model pass", async () => {
    const result = await run(
      'printf "#!/bin/sh\\necho attacker-cli\\n" > "$(command -v droid)"; droid_verify_cli',
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("integrity");
    expect(result.stdout).not.toContain("attacker-cli");
  });

  it("finalizes in the same parent and preserves the original failing status", async () => {
    const result = await run("droid_install_finalize_trap; exit 7");
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain("gitlab-collect-debug-artifacts");
    expect(result.stdout).toContain("gitlab-update-comment-link");
  });

  it("does not mask a successful job when optional finalization fails", async () => {
    const result = await run(
      "export FINALIZER_FAIL=true; droid_install_finalize_trap; exit 0",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("finalization warning");
  });
});
