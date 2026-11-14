import * as core from "@actions/core";
import { createHash } from "crypto";
import { mkdtemp, readFile, realpath, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

const entrypoints = {
  lifecycle: "../entrypoints/github-review-lifecycle.ts",
  post: "../entrypoints/github-post-review.ts",
  tracking: "../entrypoints/update-comment-link.ts",
  validator: "../entrypoints/prepare-validator.ts",
  runner: "../../base-action/src/index.ts",
  debug: "../entrypoints/collect-debug-artifacts.ts",
  revoke: "../entrypoints/revoke-github-token.ts",
  steward: "../steward/postrun.ts",
  // The risk action's last step, which no review action runs.
  settle: "../entrypoints/risk-settle.ts",
  // The full action's risk steps, which run after its review.
  risk_begin: "../entrypoints/risk-begin.ts",
  risk_token: "../entrypoints/get-token.ts",
  risk_assess: "../entrypoints/risk-assess.ts",
};
type RuntimeKind = keyof typeof entrypoints;

/** Every script the full action's risk steps run. */
export const RISK_RUNTIME_KINDS = [
  "settle",
  "risk_begin",
  "risk_token",
  "risk_assess",
] as const satisfies readonly RuntimeKind[];
const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/**
 * Freeze executable code before either review pass can edit action files.
 * Without `kinds`, every review entrypoint is frozen and no risk one is.
 */
export async function freezeReviewRuntime(
  kinds?: readonly RuntimeKind[],
): Promise<Record<string, string>> {
  const directory = await mkdtemp(join(tmpdir(), "droid-review-publishers-"));
  const outputs: Record<string, string> = {};
  for (const [kind, file] of Object.entries(entrypoints)) {
    if (
      kinds
        ? !kinds.some((selected) => selected === kind)
        : RISK_RUNTIME_KINDS.some((risk) => risk === kind)
    )
      continue;
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL(file, import.meta.url))],
      target: "bun",
      format: "esm",
      minify: false,
    });
    if (!build.success || build.outputs.length !== 1 || !build.outputs[0])
      throw new Error(`Could not freeze the trusted review ${kind} publisher`);
    const bytes = Buffer.from(await build.outputs[0].arrayBuffer());
    const publisher = join(directory, `${kind}.mjs`);
    await writeFile(publisher, bytes, { mode: 0o600 });
    outputs[`review_${kind}_publisher_path`] = publisher;
    outputs[`review_${kind}_publisher_sha256`] = sha256(bytes);
  }
  const runtime = await realpath(process.execPath);
  outputs.review_runtime_path = runtime;
  outputs.review_runtime_sha256 = sha256(await readFile(runtime));
  for (const [key, value] of Object.entries(outputs))
    core.setOutput(key, value);
  return outputs;
}
