import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as core from "@actions/core";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { DroidRunType, setDroidRunType } from "../../src/run-type";
import * as context from "../../src/github/context";
import * as client from "../../src/github/api/client";
import * as validator from "../../src/tag/commands/review-validator";
import prepareValidator from "../../src/entrypoints/prepare-validator";

type Step = {
  name: string;
  id?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
};
const root = join(import.meta.dir, "../..");
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const originalEnv = { ...process.env };
afterEach(() => {
  mock.restore();
  for (const key of Object.keys(process.env))
    if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
const manifests = [
  "action.yml",
  "review/action.yml",
  "security/action.yml",
].map((file) => ({
  file,
  steps: parse(readFileSync(join(root, file), "utf8")).runs.steps as Step[],
}));
const capturedKeys = [
  "DROID_EXEC_RUN_TYPE",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "REVIEW_MODEL",
  "REASONING_EFFORT",
  "REVIEW_EFFECTIVE_MODEL",
  "REVIEW_EFFECTIVE_REASONING",
  "UNTRUSTED_MODEL_VALUE",
  "REVIEW_SECURITY_ONLY",
];

async function execute(
  step: Step,
  role: DroidRunType,
  options: {
    verifier?: "native" | "shasum" | "missing";
    changed?: "publisher" | "runtime" | "cli";
    reasoning?: string;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "qa75-native-wrapper-"));
  try {
    const capture = join(dir, "capture");
    const publisher = join(dir, "publisher.mjs");
    const runtime = join(dir, "runtime");
    const cli = join(dir, "cli");
    const runtimeBytes = Buffer.from(
      `#!/bin/sh\nprintf '%s\\n' ${capturedKeys.map((key) => `"\${${key}-}"`).join(" ")} > "${capture}"\n`,
    );
    const publisherBytes = Buffer.from("// Frozen test publisher fixture\n");
    const cliBytes = Buffer.from("Frozen test CLI fixture\n");
    await writeFile(runtime, runtimeBytes);
    await chmod(runtime, 0o700);
    await writeFile(publisher, publisherBytes);
    await writeFile(cli, cliBytes);
    const selectedModel =
      role === DroidRunType.SecurityReview
        ? "trusted-security"
        : "trusted-main";
    const outputs: Record<string, string> = {
      droid_exec_run_type: role,
      review_model: selectedModel,
      review_reasoning_effort: options.reasoning ?? "high",
      review_security_only: String(role === DroidRunType.SecurityReview),
    };
    const env: Record<string, string> = {
      PATH: "/hostile-path",
      DROID_EXEC_RUN_TYPE: DroidRunType.Fill,
      REVIEW_EFFECTIVE_MODEL: "forged-alias",
      REVIEW_EFFECTIVE_REASONING: "forged-alias",
      UNTRUSTED_MODEL_VALUE: "must-not-cross",
    };
    for (const [key, value] of Object.entries(step.env ?? {})) {
      env[key] = value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
        const output = /^steps\.(?:prepare|prompt)\.outputs\.(\w+)$/.exec(
          expression,
        );
        if (output) return outputs[output[1]!] ?? "";
        if (
          expression ===
          "steps.prepare.outputs.review_reasoning_effort != 'default' && steps.prepare.outputs.review_reasoning_effort || ''"
        )
          return outputs.review_reasoning_effort === "default"
            ? ""
            : outputs.review_reasoning_effort!;
        if (expression === "github.run_id") return "123";
        if (expression === "github.run_attempt") return "2";
        if (expression === "inputs.review_model") return "raw-main-input";
        if (expression === "inputs.reasoning_effort") return "raw-effort";
        return "";
      });
    }
    Object.assign(env, {
      REVIEW_PUBLISHER_PATH: publisher,
      REVIEW_PUBLISHER_SHA256: digest(publisherBytes),
      REVIEW_RUNTIME_PATH: runtime,
      REVIEW_RUNTIME_SHA256: digest(runtimeBytes),
      REVIEW_CLI_PATH: cli,
      REVIEW_CLI_SHA256: digest(cliBytes),
      COMMAND_PUBLISHER_PATH: publisher,
      COMMAND_PUBLISHER_SHA256: digest(publisherBytes),
      COMMAND_RUNTIME_PATH: runtime,
      COMMAND_RUNTIME_SHA256: digest(runtimeBytes),
      TRUSTED_TAIL_PATH: publisher,
      TRUSTED_TAIL_SHA256: digest(publisherBytes),
      TRUSTED_RUNTIME_PATH: runtime,
      TRUSTED_RUNTIME_SHA256: digest(runtimeBytes),
      GITHUB_OUTPUT: join(dir, "output"),
      GITHUB_TOKEN: "synthetic-test-token",
      GITHUB_API_URL: "https://api.example.invalid",
      GITHUB_SERVER_URL: "https://example.invalid",
      COMMAND_MODE: "question",
      COMMAND_OUTPUT_PATH: join(dir, "command.json"),
      COMMAND_EXPECTED_HEAD: "a".repeat(40),
      COMMAND_FIX_MODE: "off",
      COMMAND_ROOT_COMMENT_ID: "12",
      COMMAND_PR_NUMBER: "42",
      COMMAND_ACTOR: "fixture",
      REPO_OWNER: "owner",
      REPO_NAME: "repo",
      DROID_SUCCESS: "true",
    });
    let script = step.run!;
    if (options.verifier === "shasum" || options.verifier === "missing") {
      // Exercise the actual YAML branch on Linux with only absolute verifier
      // locations remapped. This is not a macOS runtime test.
      script = script.replaceAll("/usr/bin/sha256sum", join(dir, "no-gnu"));
      if (options.verifier === "missing")
        script = script.replaceAll("/usr/bin/shasum", join(dir, "no-shasum"));
    }
    if (options.changed === "publisher")
      await writeFile(publisher, "changed publisher\n");
    if (options.changed === "runtime")
      await writeFile(runtime, runtimeBytes.toString() + "# changed runtime\n");
    if (options.changed === "cli") await writeFile(cli, "changed CLI\n");
    const scriptPath = join(dir, "step.sh");
    await writeFile(scriptPath, script);
    const child = Bun.spawn(
      [...step.shell!.split(" ").slice(0, -1), scriptPath],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    let captured: Record<string, string> | undefined;
    try {
      const values = (await readFile(capture, "utf8")).split("\n");
      captured = Object.fromEntries(
        capturedKeys.map((key, index) => [key, values[index] ?? ""]),
      );
    } catch {
      // A refused executable must never reach the capture fixture.
    }
    return { stdout, stderr, exit, captured, selectedModel };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("QA75 trusted native wrapper behavior", () => {
  for (const { file, steps } of manifests) {
    const native = steps.filter((step) =>
      step.run?.includes("/usr/bin/env -i"),
    );
    for (const step of native) {
      it(`${file}: ${step.name} verifies with absolute shasum when GNU is absent`, async () => {
        const result = await execute(step, DroidRunType.Review, {
          verifier: "shasum",
        });
        expect({ exit: result.exit, stderr: result.stderr }).toEqual({
          exit: 0,
          stderr: "",
        });
        expect(result.captured).toBeDefined();
      });
    }
    const post = steps.find((step) => step.id === "post_review")!;
    it(`${file}: trusted canonical model metadata crosses without ambient aliases`, async () => {
      const role =
        file === "security/action.yml"
          ? DroidRunType.SecurityReview
          : DroidRunType.Review;
      const result = await execute(post, role);
      expect(result.exit).toBe(0);
      expect(result.captured?.REVIEW_MODEL).toBe(result.selectedModel);
      expect(result.captured?.REASONING_EFFORT).toBe("high");
      expect(result.captured?.REVIEW_EFFECTIVE_MODEL).toBe("");
      expect(result.captured?.REVIEW_EFFECTIVE_REASONING).toBe("");
      expect(result.captured?.UNTRUSTED_MODEL_VALUE).toBe("");
    });
    for (const step of native.filter((step) =>
      step.run?.includes("$REVIEW_PUBLISHER_PATH"),
    )) {
      const roles =
        file === "action.yml"
          ? [
              DroidRunType.Default,
              DroidRunType.Review,
              DroidRunType.SecurityReview,
            ]
          : [
              file === "security/action.yml"
                ? DroidRunType.SecurityReview
                : DroidRunType.Review,
            ];
      if (file === "action.yml" && step.name === "Update comment with job link")
        roles.push(DroidRunType.SecurityScan);
      for (const role of roles) {
        it(`${file}: ${step.name} preserves trusted ${role} and numeric rerun metadata`, async () => {
          const result = await execute(step, role);
          expect(result.exit).toBe(0);
          expect(result.captured?.DROID_EXEC_RUN_TYPE).toBe(role);
          expect(result.captured?.GITHUB_RUN_ATTEMPT).toBe("2");
          expect(result.captured?.UNTRUSTED_MODEL_VALUE).toBe("");
          expect(step.env?.DROID_EXEC_RUN_TYPE).toBe(
            file === "action.yml"
              ? "${{ steps.prepare.outputs.droid_exec_run_type }}"
              : "${{ steps.prompt.outputs.droid_exec_run_type }}",
          );
        });
      }
    }
    const prepare = steps.find((step) => step.id === "prepare_validator")!;
    it(`${file}: validator uses the trusted selected main/security model`, async () => {
      const role =
        file === "security/action.yml"
          ? DroidRunType.SecurityReview
          : DroidRunType.Review;
      const result = await execute(prepare, role);
      expect(result.exit).toBe(0);
      expect(result.captured?.REVIEW_MODEL).toBe(result.selectedModel);
      expect(result.captured?.REASONING_EFFORT).toBe("high");
    });
    if (file === "action.yml")
      it("root shallow validator does not turn the unset display sentinel into a CLI reasoning override", async () => {
        const result = await execute(prepare, DroidRunType.Review, {
          reasoning: "default",
        });
        expect(result.exit).toBe(0);
        expect(result.captured?.REASONING_EFFORT).toBe("");
      });
    for (const changed of ["publisher", "runtime"] as const) {
      it(`${file}: still refuses altered ${changed} bytes`, async () => {
        const result = await execute(post, DroidRunType.Review, { changed });
        expect(result.exit).not.toBe(0);
        expect(result.captured).toBeUndefined();
      });
    }
    it(`${file}: still fails closed without an absolute verifier`, async () => {
      const result = await execute(post, DroidRunType.Review, {
        verifier: "missing",
      });
      expect(result.exit).not.toBe(0);
      expect(result.captured).toBeUndefined();
    });
    const runValidator = steps.find(
      (step) => step.id === "droid_validator" || step.id === "validator",
    )!;
    it(`${file}: still refuses an altered frozen validator CLI`, async () => {
      const result = await execute(runValidator, DroidRunType.Review, {
        changed: "cli",
      });
      expect(result.exit).not.toBe(0);
      expect(result.captured).toBeUndefined();
    });
  }
});

describe("QA75 semantic role preparation", () => {
  it("publishes a trusted role output for review/security/scan instead of relying on mutable job env", () => {
    const output = spyOn(core, "setOutput").mockImplementation(() => {});
    delete process.env.GITHUB_ENV;
    for (const role of [
      DroidRunType.Default,
      DroidRunType.Review,
      DroidRunType.SecurityReview,
      DroidRunType.SecurityScan,
    ]) {
      setDroidRunType(role);
      expect(output).toHaveBeenCalledWith("droid_exec_run_type", role);
    }
  });
  it("rejects a non-review role before creating validator API clients", async () => {
    spyOn(context, "parseGitHubContext").mockReturnValue({
      isPR: true,
      entityNumber: 42,
      eventName: "issue_comment",
    } as any);
    const octokit = spyOn(client, "createOctokit").mockReturnValue({} as any);
    const prepare = spyOn(
      validator,
      "prepareReviewValidatorMode",
    ).mockResolvedValue({} as any);
    spyOn(core, "setFailed").mockImplementation(() => {});
    spyOn(core, "setOutput").mockImplementation(() => {});
    spyOn(core, "setSecret").mockImplementation(() => {});
    spyOn(process, "exit").mockImplementation((() => {
      throw new Error("fixture process.exit");
    }) as any);
    process.env.DROID_EXEC_RUN_TYPE = DroidRunType.Fill;
    process.env.GITHUB_TOKEN = "synthetic-test-token";
    process.env.DROID_COMMENT_ID = "12";
    delete process.env.REVIEW_CANDIDATES_PATH;
    await expect(prepareValidator()).rejects.toThrow("fixture process.exit");
    expect(octokit).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
});
