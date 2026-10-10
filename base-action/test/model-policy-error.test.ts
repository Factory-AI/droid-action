import { describe, expect, it } from "bun:test";
import {
  condenseInvalidModelError,
  describeModelFallback,
  getLegacyTierAliasModel,
  getModelArg,
  isInvalidModelError,
  isModelPolicyError,
  parseModelPolicyFallbackMode,
  replaceModelArg,
  stripModelArgs,
} from "../src/utils/model-policy-error";

describe("parseModelPolicyFallbackMode", () => {
  it.each([undefined, "", "   ", "organization-default"])(
    "defaults or accepts organization-default: %j",
    (value) => {
      expect(parseModelPolicyFallbackMode(value)).toBe("organization-default");
    },
  );
  it("accepts fail with surrounding whitespace", () => {
    expect(parseModelPolicyFallbackMode(" fail ")).toBe("fail");
  });
  it("rejects unsupported modes", () => {
    expect(() => parseModelPolicyFallbackMode("typo")).toThrow(
      "model_policy_fallback must be one of:",
    );
  });
});

describe("getModelArg", () => {
  it("reads --model <value> and --model=value forms", () => {
    expect(getModelArg(["exec", "--model", "gpt-5.2", "-f", "p"])).toBe(
      "gpt-5.2",
    );
    expect(getModelArg(["exec", "--model=openai-latest-balanced"])).toBe(
      "openai-latest-balanced",
    );
  });

  it("returns undefined when no model is set", () => {
    expect(getModelArg(["exec", "-f", "p"])).toBeUndefined();
  });
});

describe("getLegacyTierAliasModel", () => {
  it("maps every tier alias to a concrete model", () => {
    for (const provider of ["openai", "anthropic", "oss"]) {
      for (const tier of ["premium", "balanced", "fast"]) {
        expect(
          getLegacyTierAliasModel(`${provider}-latest-${tier}`),
        ).toBeTruthy();
      }
    }
    expect(getLegacyTierAliasModel("openai-latest-balanced")).toBe(
      "gpt-5.6-sol",
    );
  });

  it("returns undefined for concrete models and missing values", () => {
    expect(getLegacyTierAliasModel("gpt-5.2")).toBeUndefined();
    expect(getLegacyTierAliasModel("toString")).toBeUndefined();
    expect(getLegacyTierAliasModel(undefined)).toBeUndefined();
  });
});

describe("replaceModelArg", () => {
  it("swaps the model value and keeps reasoning effort", () => {
    expect(
      replaceModelArg(
        [
          "exec",
          "--model",
          "openai-latest-balanced",
          "--reasoning-effort",
          "high",
        ],
        "gpt-5.6-sol",
      ),
    ).toEqual(["exec", "--model", "gpt-5.6-sol", "--reasoning-effort", "high"]);
    expect(
      replaceModelArg(["--model=oss-latest-fast"], "glm-5.3-flash"),
    ).toEqual(["--model=glm-5.3-flash"]);
  });
});

describe("describeModelFallback", () => {
  it("points at the model input for an unrecognized concrete model id", () => {
    const note = describeModelFallback({
      policyBlocked: false,
      model: "gpt-image-1",
    });
    expect(note).toContain("The model `gpt-image-1` is not a recognized");
    expect(note).toContain("`review_model`");
  });

  it("describes a policy block even for tier aliases", () => {
    const note = describeModelFallback({
      policyBlocked: true,
      model: "openai-latest-premium",
    });
    expect(note).toContain("not allowed by your organization's model policy");
    expect(note).toContain("`review_model`");
  });
});

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

  it("matches the droid exec pre-flight policy rejection on stderr", () => {
    expect(
      isModelPolicyError(
        "Model blocked by organization policy: \n\nRun 'droid settings' to see available models.",
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
