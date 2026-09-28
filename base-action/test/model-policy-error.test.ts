import { describe, expect, it } from "bun:test";
import {
  condenseInvalidModelError,
  isInvalidModelError,
  isModelPolicyError,
  stripModelArgs,
} from "../src/utils/model-policy-error";

describe("isModelPolicyError", () => {
  it("matches the model policy 403 message", () => {
    expect(
      isModelPolicyError(
        `403 {"detail":"This model is not available due to your organization's security settings.","status":403}`,
      ),
    ).toBe(true);
  });

  it("matches with a curly apostrophe", () => {
    expect(
      isModelPolicyError(
        "This model is not available due to your organization’s security settings.",
      ),
    ).toBe(true);
  });

  it("matches the explicit opt-in 403 message", () => {
    expect(
      isModelPolicyError(
        "403 This model requires explicit organization opt-in by an admin.",
      ),
    ).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isModelPolicyError("429 Too Many Requests")).toBe(false);
    expect(isModelPolicyError(undefined)).toBe(false);
  });
});

describe("isInvalidModelError", () => {
  it("matches the CLI invalid-model stderr output", () => {
    expect(isInvalidModelError("Invalid model: gpt-image-1")).toBe(true);
  });

  it("does not match unrelated output", () => {
    expect(isInvalidModelError("500 Internal Server Error")).toBe(false);
    expect(isInvalidModelError(undefined)).toBe(false);
  });
});

describe("condenseInvalidModelError", () => {
  it("drops the model-list dump and dedupes repeated lines", () => {
    const dump = [
      "claude-opus-5, claude-sonnet-5, gpt-5.4, gpt-5.2, kimi-k3, glm-5.2",
      "",
      "No custom models configured. Add them to ~/.factory/settings.json",
      "Invalid model: gpt-image-1",
      "",
      "Available built-in models:",
      "  auto, claude-opus-5, claude-sonnet-5, gpt-5.4, gpt-5.2, kimi-k3",
      "",
      "No custom models configured. Add them to ~/.factory/settings.json",
      "Invalid model: gpt-image-1",
    ].join("\n");

    expect(condenseInvalidModelError(dump)).toBe("Invalid model: gpt-image-1");
  });

  it("returns the original text when nothing would remain", () => {
    const listOnly = "a, b, c, d, e, f";
    expect(condenseInvalidModelError(listOnly)).toBe(listOnly);
  });
});

describe("stripModelArgs", () => {
  it("removes --model and its value", () => {
    expect(
      stripModelArgs(["exec", "--model", "gpt-5.2", "-f", "prompt.txt"]),
    ).toEqual(["exec", "-f", "prompt.txt"]);
  });

  it("removes --reasoning-effort and its value", () => {
    expect(
      stripModelArgs(["exec", "--reasoning-effort", "high", "-f", "p.txt"]),
    ).toEqual(["exec", "-f", "p.txt"]);
  });

  it("removes --flag=value forms", () => {
    expect(
      stripModelArgs(["exec", "--model=gpt-5.2", "--reasoning-effort=high"]),
    ).toEqual(["exec"]);
  });

  it("removes both flags while preserving other args", () => {
    expect(
      stripModelArgs([
        "exec",
        "--output-format",
        "stream-json",
        "--model",
        "kimi-k2.6",
        "--reasoning-effort",
        "high",
        "--tag",
        "code-review",
      ]),
    ).toEqual([
      "exec",
      "--output-format",
      "stream-json",
      "--tag",
      "code-review",
    ]);
  });

  it("returns args unchanged when no model flags are present", () => {
    const args = ["exec", "--output-format", "stream-json", "-f", "p.txt"];
    expect(stripModelArgs(args)).toEqual(args);
  });
});
