import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { parseAllDocuments } from "yaml";

/**
 * Runs every bun step of templates/droid-review.yml with real bun,
 * from an MR checkout that plants a `bunfig.toml` preload. The preload would
 * copy GITLAB_TOKEN to disk if bun picked up the checkout's config.
 */

const ROOT = path.resolve(import.meta.dir, "../..");

type Job = { script: string[]; after_script: string[] };

async function loadJob(): Promise<Job> {
  const raw = await fs.readFile(
    path.join(ROOT, "templates/droid-review.yml"),
    "utf8",
  );
  const docs = parseAllDocuments(raw);
  return (docs[1]!.toJSON() as { "droid-review": Job })["droid-review"];
}

let tmp: string;
let work: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "droid-gl-tpl-"));
  work = path.join(tmp, "work");
  await fs.mkdir(work);
  const bin = path.join(tmp, "bin");
  await fs.mkdir(bin);
  // npm's Bun 1.2.11 package names its executable bun.exe. Expose that exact
  // running binary as bun, rather than relying on its directory's filename.
  await fs.symlink(process.execPath, path.join(bin, "bun"));
  await fs.writeFile(
    path.join(work, "bunfig.toml"),
    'preload = ["./evil.ts"]\n',
  );
  await fs.writeFile(
    path.join(work, "evil.ts"),
    `require("fs").appendFileSync(${JSON.stringify(path.join(tmp, "pwned"))}, String(process.env.GITLAB_TOKEN) + "\\n");\n`,
  );
  await fs.writeFile(
    path.join(work, "probe.ts"),
    'console.log("probe complete");\n',
  );
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function runStep(step: string) {
  const proc = Bun.spawn(["bash", "-c", step], {
    cwd: work,
    env: {
      PATH: `${path.join(tmp, "bin")}:/usr/local/bin:/usr/bin:/bin`,
      HOME: path.join(tmp, "home"),
      CI_PROJECT_DIR: work,
      DROID_ACTION_DIR: ROOT,
      DROID_STATE_FILE: path.join(tmp, "prompts", ".droid-state.json"),
      DROID_PROMPT_FILE: path.join(tmp, "prompts", "droid-prompt.txt"),
      // Unroutable, so any entrypoint that gets as far as the API fails fast.
      CI_API_V4_URL: "http://127.0.0.1:9/api/v4",
      GITLAB_TOKEN: "gl-secret",
      FACTORY_API_KEY: "fk-secret",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

describe("templates/droid-review.yml", () => {
  it("the planted bunfig.toml runs its preload when bun starts in the checkout", async () => {
    await runStep(
      `bun run "${ROOT}/src/entrypoints/gitlab-update-comment-link.ts"`,
    );
    expect(await fs.readFile(path.join(tmp, "pwned"), "utf8")).toContain(
      "gl-secret",
    );
  }, 30_000);

  it("the planted bunfig.toml runs its preload for a script in the checkout", async () => {
    // A successful minimal script makes startup failures visible rather than
    // allowing a missing executable to masquerade as config isolation.
    const result = await runStep('bun run "./probe.ts"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("probe complete");
    expect(await fs.readFile(path.join(tmp, "pwned"), "utf8")).toContain(
      "gl-secret",
    );
  }, 30_000);

  it("the template's isolation flags block the same planted preload", async () => {
    const result = await runStep(
      'bun --config=/dev/null --env-file=/dev/null run "./probe.ts"',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("probe complete");
    expect(await exists(path.join(tmp, "pwned"))).toBe(false);
  }, 30_000);

  it("never starts bun in the MR checkout", async () => {
    const job = await loadJob();
    const steps = [...job.script, ...job.after_script].filter((s) =>
      /\bbun\b.*\brun\b/.test(s),
    );
    expect(steps).toHaveLength(5);

    for (const step of steps) {
      await runStep(step);
    }

    expect(await exists(path.join(tmp, "pwned"))).toBe(false);
  }, 60_000);
});
