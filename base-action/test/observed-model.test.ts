import { describe, test, expect } from "bun:test";
import { extractObservedModel } from "../src/utils/observed-model";

describe("extractObservedModel", () => {
  test("reads the model from the system init event", () => {
    expect(
      extractObservedModel({
        type: "system",
        subtype: "init",
        session_id: "abc",
        model: "factory-droid-latest",
      }),
    ).toBe("factory-droid-latest");
  });

  test("ignores a system event without a model", () => {
    expect(
      extractObservedModel({ type: "system", subtype: "init" }),
    ).toBeUndefined();
  });

  test("reads modelId from an assistant event", () => {
    expect(
      extractObservedModel({ type: "assistant", modelId: "gpt-5.2" }),
    ).toBe("gpt-5.2");
  });

  test("reads model from a message event", () => {
    expect(extractObservedModel({ type: "message", model: "gpt-5.2" })).toBe(
      "gpt-5.2",
    );
  });

  test("reads the model from a completion event's message field", () => {
    expect(
      extractObservedModel({
        type: "completion",
        message: { model: "claude-sonnet-4-5-20250929" },
      }),
    ).toBe("claude-sonnet-4-5-20250929");
    expect(
      extractObservedModel({
        type: "message",
        message: { modelId: "gpt-5.2" },
      }),
    ).toBe("gpt-5.2");
  });

  test("prefers the event-level id over the message field", () => {
    expect(
      extractObservedModel({
        type: "assistant",
        model: "gpt-5.2",
        message: { model: "claude-x" },
      }),
    ).toBe("gpt-5.2");
  });

  test("ignores events the CLI never reports a model on", () => {
    expect(
      extractObservedModel({ type: "tool_call", model: "injected" }),
    ).toBeUndefined();
    expect(
      extractObservedModel({
        type: "result",
        is_error: false,
        model: "injected",
      }),
    ).toBeUndefined();
    expect(
      extractObservedModel({ type: "error", message: "boom" }),
    ).toBeUndefined();
  });

  test("rejects ids that are not plain bounded identifiers", () => {
    for (const hostile of [
      "**bold**",
      "[link](https://example.invalid)",
      "a\nb",
      "a b",
      "x".repeat(161),
      "",
      "   ",
      42,
    ]) {
      expect(
        extractObservedModel({ type: "system", model: hostile }),
      ).toBeUndefined();
      expect(
        extractObservedModel({ type: "assistant", model: hostile }),
      ).toBeUndefined();
    }
  });

  test("accepts the longest well-formed ids and provider-prefixed ones", () => {
    expect(
      extractObservedModel({ type: "assistant", model: "a".repeat(160) }),
    ).toBe("a".repeat(160));
    expect(
      extractObservedModel({
        type: "assistant",
        model: "anthropic-latest-balanced",
      }),
    ).toBe("anthropic-latest-balanced");
  });

  test("ignores non-object and malformed input", () => {
    expect(extractObservedModel(null)).toBeUndefined();
    expect(extractObservedModel("system init")).toBeUndefined();
    expect(extractObservedModel(42)).toBeUndefined();
  });
});
