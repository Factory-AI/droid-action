import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { parse } from "yaml";
import { AMBIENT } from "../src/core/worker/step";
import { freezeReviewCli } from "../src/entrypoints/freeze-review-cli";
import { createControlledRuntime } from "./helpers/controlled-runtime";

const manifest = parse(
  readFileSync(join(import.meta.dir, "../action.yml"), "utf8"),
);
const digest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

describe("frozen review executable workflow boundary", () => {
  it("binds the selected CLI to an absolute pre-model executable and digest", async () => {
    const output = await freezeReviewCli(process.execPath);
    expect(output.review_cli_path).toStartWith("/");
    expect(digest(await readFile(output.review_cli_path!))).toBe(
      output.review_cli_sha256,
    );
  });
  it("runs the actual publisher shell with allowlisted env, gives the review step how the runner reaches the network and no GitHub token, and refuses altered Droid CLI bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-runtime-guard-"));
    try {
      const capture = join(directory, "captured.json");
      const publisher = join(directory, "publisher.mjs");
      const source = Buffer.from(
        `import {writeFileSync} from "fs";writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.env));`,
      );
      await writeFile(publisher, source);
      const cli = join(directory, "fake-droid");
      await writeFile(cli, "original cli");
      const cliHash = digest(await readFile(cli));
      // What a pull request can leave where the steps run.
      const preloaded = join(directory, "preloaded");
      await writeFile(
        join(directory, "preload.mjs"),
        `import {writeFileSync} from "fs";writeFileSync(${JSON.stringify(preloaded)},"");`,
      );
      await writeFile(
        join(directory, "bunfig.toml"),
        `preload = [${JSON.stringify(join(directory, "preload.mjs"))}]\n`,
      );
      await writeFile(join(directory, ".env"), "LEFT_IN_WORKSPACE=1\n");
      const answeredAbout = {
        REVIEW_HEAD_SHA: "a".repeat(40),
        REVIEW_BASE_SHA: "b".repeat(40),
        REVIEW_SECURITY_ONLY: "true",
        REVIEW_VALIDATED_PATH: join(directory, "validated.json"),
        WORKER_DIR: join(directory, "droid-worker"),
      };
      // Every name a session keeps, as a runner behind a proxy holds them.
      const ambient = Object.fromEntries(
        AMBIENT.map((name) => [name, `runner-${name}`]),
      );
      const controlledRuntime = await createControlledRuntime(directory);
      const runtime = await freezeReviewCli(controlledRuntime.path);
      const post = manifest.runs.steps.find(
        (step: { id?: string }) => step.id === "post_review",
      );
      const review = manifest.runs.steps.find(
        (step: { id?: string }) => step.id === "review",
      );
      const execute = async (step: {
        run: string;
        shell: string;
        env: Record<string, string>;
      }) => {
        const script = join(directory, "step.sh");
        await writeFile(script, step.run);
        const child = Bun.spawn(
          [...step.shell.split(" ").slice(0, -1), script],
          {
            cwd: directory,
            env: {
              ...answeredAbout,
              ...ambient,
              ...Object.fromEntries(
                Object.entries(step.env).filter(([, value]) => value === ""),
              ),
              GITHUB_TOKEN: "synthetic-only",
              WORKER_TOKEN: "synthetic-only",
              FACTORY_API_KEY: "synthetic-factory-key",
              TRUSTED_TAIL_PATH: publisher,
              TRUSTED_TAIL_SHA256: digest(source),
              TRUSTED_RUNTIME_PATH: runtime.review_cli_path,
              TRUSTED_RUNTIME_SHA256: runtime.review_cli_sha256,
              REVIEW_PUBLISHER_PATH: publisher,
              REVIEW_PUBLISHER_SHA256: digest(source),
              REVIEW_RUNTIME_PATH: runtime.review_cli_path,
              REVIEW_RUNTIME_SHA256: runtime.review_cli_sha256,
              REVIEW_CLI_PATH: cli,
              REVIEW_CLI_SHA256: cliHash,
              PATH: "/untrusted-path",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { stdout, stderr, exit };
      };
      expect((await execute(post)).exit).toBe(0);
      const env = JSON.parse(await readFile(capture, "utf8"));
      expect(env.GITHUB_TOKEN).toBe("synthetic-only");
      // A step that holds a GitHub token runs after pull request code, which
      // can have changed what the runner holds for these names.
      for (const name of AMBIENT) expect(env[name]).toBeUndefined();
      await rm(capture);
      expect((await execute(review)).exit).toBe(0);
      const reviewEnv = JSON.parse(await readFile(capture, "utf8"));
      expect(reviewEnv).toMatchObject(ambient);
      expect(reviewEnv.GITHUB_TOKEN).toBeUndefined();
      expect(reviewEnv.WORKER_TOKEN).toBeUndefined();
      expect(reviewEnv.FACTORY_API_KEY).toBe("synthetic-factory-key");
      expect(reviewEnv.DROID_BIN).toBe(cli);
      expect(reviewEnv).toMatchObject(answeredAbout);
      expect(reviewEnv.LEFT_IN_WORKSPACE).toBeUndefined();
      await expect(readFile(preloaded)).rejects.toThrow();
      await rm(capture);
      await writeFile(cli, "altered cli");
      const denied = await execute(review);
      expect(denied.exit).toBe(1);
      expect(denied.stdout).toContain("Droid executable changed");
      await expect(readFile(capture)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
