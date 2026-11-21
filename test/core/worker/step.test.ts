import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StepError,
  describeFailure,
  failureReason,
  writePrivateJson,
} from "../../../src/core/worker/step";

describe("failures", () => {
  it("labels only its own errors, and only with a well-formed reason", () => {
    expect(failureReason(new StepError("judge_timeout", "timed out"))).toBe(
      "judge_timeout",
    );
    expect(failureReason(new StepError("Not A Label", "odd"))).toBe(
      "unexpected",
    );
    expect(failureReason(new Error("boom"))).toBe("unexpected");
    expect(failureReason("boom")).toBe("unexpected");
  });

  it("removes the job's credentials from a message before it is logged", () => {
    const saved = process.env.FACTORY_API_KEY;
    process.env.FACTORY_API_KEY = "fk-super-secret-value";
    try {
      const logged = describeFailure(
        new Error(
          `request with fk-super-secret-value failed ${"x".repeat(5000)}`,
        ),
      );
      expect(logged).not.toContain("fk-super-secret-value");
      expect(logged.length).toBeLessThanOrEqual(2000);
    } finally {
      if (saved === undefined) delete process.env.FACTORY_API_KEY;
      else process.env.FACTORY_API_KEY = saved;
    }
  });
});

describe("writePrivateJson", () => {
  it("writes a file readable by its owner alone, even over a file that was not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "droid-worker-step-test-"));
    try {
      const path = join(dir, "nested", "plan.json");
      await writePrivateJson(path, { pr: 123 });
      expect((await stat(path)).mode % 0o1000).toBe(0o600);
      expect((await stat(join(dir, "nested"))).mode % 0o1000).toBe(0o700);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ pr: 123 });

      const loose = join(dir, "loose.json");
      await writeFile(loose, "{}", { mode: 0o644 });
      await writePrivateJson(loose, { pr: 123 });
      expect((await stat(loose)).mode % 0o1000).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
