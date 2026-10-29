import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { parse } from "yaml";
import { freezeReviewCli } from "../src/entrypoints/freeze-review-cli";

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
  it("runs the actual publisher shell with allowlisted env and refuses altered validator CLI bytes", async () => {
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
      const runtime = await freezeReviewCli(process.execPath);
      const post = manifest.runs.steps.find(
        (step: { id?: string }) => step.id === "post_review",
      );
      const validator = manifest.runs.steps.find(
        (step: { id?: string }) => step.id === "droid_validator",
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
            env: {
              HTTPS_PROXY: "https://untrusted.invalid",
              NODE_EXTRA_CA_CERTS: "/untrusted-cert",
              ...Object.fromEntries(
                Object.entries(step.env).filter(([, value]) => value === ""),
              ),
              GITHUB_TOKEN: "synthetic-only",
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
      expect(env.HTTPS_PROXY).toBeUndefined();
      expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
      await rm(capture);
      await writeFile(cli, "altered cli");
      const denied = await execute(validator);
      expect(denied.exit).toBe(1);
      expect(denied.stdout).toContain("Droid executable changed");
      await expect(readFile(capture)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
