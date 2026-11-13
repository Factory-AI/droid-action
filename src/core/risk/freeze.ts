import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RiskError } from "./types";

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export type FrozenRiskSettle = {
  settlePath: string;
  settleSha256: string;
  runtimePath: string;
  runtimeSha256: string;
};

/**
 * Bundles the settle entrypoint into one file outside the action's checkout
 * and records its digest and the runtime's. The judge runs pull request code
 * before the settle step does, so that step runs this copy, after checking
 * both digests, instead of whatever the checkout and PATH hold by then.
 */
export async function freezeRiskSettle(): Promise<FrozenRiskSettle> {
  const build = await Bun.build({
    entrypoints: [
      fileURLToPath(
        new URL("../../entrypoints/risk-settle.ts", import.meta.url),
      ),
    ],
    target: "bun",
    format: "esm",
    minify: false,
  });
  const [output] = build.outputs;
  if (!build.success || build.outputs.length !== 1 || !output) {
    throw new RiskError(
      "settle_freeze_failed",
      "Could not freeze the settle step",
    );
  }
  const bytes = Buffer.from(await output.arrayBuffer());
  const settlePath = join(
    await mkdtemp(join(tmpdir(), "droid-risk-settle-")),
    "settle.mjs",
  );
  await writeFile(settlePath, bytes, { mode: 0o600 });
  const runtimePath = await realpath(process.execPath);
  return {
    settlePath,
    settleSha256: sha256(bytes),
    runtimePath,
    runtimeSha256: sha256(await readFile(runtimePath)),
  };
}
