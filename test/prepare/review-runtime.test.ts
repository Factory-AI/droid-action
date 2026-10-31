import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { readFile, rm } from "fs/promises";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

describe("trusted review publisher artifacts", () => {
  it("bundles all eight real entrypoints and binds their exact executable bytes", async () => {
    // The real action runs outside Bun's test-module/mock resolver.
    const helper = pathToFileURL(
      join(import.meta.dir, "../../src/prepare/review-runtime.ts"),
    ).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "--config=/dev/null",
        "--env-file=/dev/null",
        "--eval",
        `const {freezeReviewRuntime}=await import(${JSON.stringify(helper)});console.log("__OUTPUTS__"+JSON.stringify(await freezeReviewRuntime()));`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH },
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const line = stdout
      .split("\n")
      .find((line) => line.startsWith("__OUTPUTS__"));
    expect(line).toBeDefined();
    const outputs: Record<string, string> = JSON.parse(
      line!.slice("__OUTPUTS__".length),
    );
    const directory = dirname(outputs.review_lifecycle_publisher_path!);
    try {
      for (const kind of [
        "lifecycle",
        "post",
        "tracking",
        "validator",
        "runner",
        "debug",
        "revoke",
        "steward",
      ]) {
        const file = outputs[`review_${kind}_publisher_path`]!;
        const bytes = await readFile(file);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          outputs[`review_${kind}_publisher_sha256`]!,
        );
        // Importing the frozen artifact must not execute its CLI entrypoint.
        const module = await import(pathToFileURL(file).href);
        if (["lifecycle", "post", "tracking"].includes(kind))
          expect(typeof module.run).toBe("function");
      }
      expect(
        createHash("sha256")
          .update(await readFile(outputs.review_runtime_path!))
          .digest("hex"),
      ).toBe(outputs.review_runtime_sha256!);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
