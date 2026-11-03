import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parse } from "yaml";

type Step = {
  name: string;
  id?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
};
const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const runtime = await realpath(process.execPath);
const runtimeHash = hash(await readFile(runtime));

describe("trusted numeric attempt reaches actual native review children", () => {
  for (const file of [
    "action.yml",
    "review/action.yml",
    "security/action.yml",
  ]) {
    const manifest = parse(
      readFileSync(join(import.meta.dir, "..", file), "utf8"),
    );
    const steps: Step[] = manifest.runs.steps.filter(
      (step: Step) =>
        step.id === "post_review" || step.name?.startsWith("Review lifecycle "),
    );
    for (const step of steps) {
      it(`${file}: ${step.name}`, async () => {
        const directory = await mkdtemp(
          join(tmpdir(), "review-attempt-child-"),
        );
        try {
          const capture = join(directory, "session.json");
          const publisher = join(directory, "publisher.mjs");
          const source = Buffer.from(
            `import {writeFileSync} from "fs";writeFileSync(${JSON.stringify(capture)},JSON.stringify({runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,untrusted:process.env.UNTRUSTED_MODEL_VALUE}));`,
          );
          await writeFile(publisher, source);
          const script = join(directory, "step.sh");
          await writeFile(script, step.run!);
          const child = Bun.spawn(
            [...step.shell!.split(" ").slice(0, -1), script],
            {
              env: {
                ...Object.fromEntries(
                  Object.entries(step.env ?? {}).filter(
                    ([, value]) => value === "",
                  ),
                ),
                PATH: "/usr/bin:/bin",
                GITHUB_RUN_ID: "123",
                GITHUB_RUN_ATTEMPT: "2",
                UNTRUSTED_MODEL_VALUE: "must-not-cross",
                REVIEW_PUBLISHER_PATH: publisher,
                REVIEW_PUBLISHER_SHA256: hash(source),
                REVIEW_RUNTIME_PATH: runtime,
                REVIEW_RUNTIME_SHA256: runtimeHash,
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
          expect({ exit, stderr, stdout }).toEqual({
            exit: 0,
            stderr: "",
            stdout: "",
          });
          const session = JSON.parse(await readFile(capture, "utf8"));
          expect(session).toEqual({ runId: "123", runAttempt: "2" });
          expect(step.env?.GITHUB_RUN_ATTEMPT).toBe(
            "${{ github.run_attempt }}",
          );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  }
});
