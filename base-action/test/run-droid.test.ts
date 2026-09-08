#!/usr/bin/env bun

import { describe, test, expect } from "bun:test";
import {
  createTurnCounter,
  parseMaxTurns,
  prepareRunConfig,
  type DroidOptions,
} from "../src/run-droid";

describe("prepareRunConfig", () => {
  test("should prepare config with basic arguments", () => {
    const options: DroidOptions = {};
    const prepared = prepareRunConfig("/tmp/test-prompt.txt", options);

    expect(prepared.droidArgs).toEqual([
      "exec",
      "--output-format",
      "stream-json",
      "--skip-permissions-unsafe",
      "-f",
      "/tmp/test-prompt.txt",
    ]);
  });

  test("should include promptPath", () => {
    const options: DroidOptions = {};
    const prepared = prepareRunConfig("/tmp/test-prompt.txt", options);

    expect(prepared.promptPath).toBe("/tmp/test-prompt.txt");
  });

  test("should use provided prompt path", () => {
    const options: DroidOptions = {};
    const prepared = prepareRunConfig("/custom/prompt/path.txt", options);

    expect(prepared.promptPath).toBe("/custom/prompt/path.txt");
  });

  describe("droidArgs handling", () => {
    test("should parse and include custom Droid arguments", () => {
      const options: DroidOptions = {
        droidArgs: "--max-turns 10 --model factory-droid-latest",
      };
      const prepared = prepareRunConfig("/tmp/test-prompt.txt", options);

      expect(prepared.droidArgs).toEqual([
        "exec",
        "--output-format",
        "stream-json",
        "--skip-permissions-unsafe",
        "--max-turns",
        "10",
        "--model",
        "factory-droid-latest",
        "-f",
        "/tmp/test-prompt.txt",
      ]);
    });

    test("should handle empty droidArgs", () => {
      const options: DroidOptions = {
        droidArgs: "",
      };
      const prepared = prepareRunConfig("/tmp/test-prompt.txt", options);

      expect(prepared.droidArgs).toEqual([
        "exec",
        "--output-format",
        "stream-json",
        "--skip-permissions-unsafe",
        "-f",
        "/tmp/test-prompt.txt",
      ]);
    });

    test("should handle droidArgs with quoted strings", () => {
      const options: DroidOptions = {
        droidArgs: '--system-prompt "You are a helpful assistant"',
      };
      const prepared = prepareRunConfig("/tmp/test-prompt.txt", options);

      expect(prepared.droidArgs).toEqual([
        "exec",
        "--output-format",
        "stream-json",
        "--skip-permissions-unsafe",
        "--system-prompt",
        "You are a helpful assistant",
        "-f",
        "/tmp/test-prompt.txt",
      ]);
    });
  });

  test("maxTurns is enforced by the action, not forwarded as a CLI flag", () => {
    // `droid exec` rejects unknown options, so a forwarded --max-turns would
    // fail every run instead of bounding it.
    const prepared = prepareRunConfig("/tmp/test-prompt.txt", {
      maxTurns: "40",
    });

    expect(prepared.droidArgs).not.toContain("--max-turns");
  });
});

describe("parseMaxTurns", () => {
  test("treats empty input as no limit", () => {
    expect(parseMaxTurns(undefined)).toBeNull();
    expect(parseMaxTurns("")).toBeNull();
    expect(parseMaxTurns("   ")).toBeNull();
  });

  test("parses a positive integer", () => {
    expect(parseMaxTurns("40")).toBe(40);
    expect(parseMaxTurns(" 100 ")).toBe(100);
  });

  test("rejects non-positive or non-integer values", () => {
    expect(() => parseMaxTurns("0")).toThrow(/positive integer/);
    expect(() => parseMaxTurns("-3")).toThrow(/positive integer/);
    expect(() => parseMaxTurns("2.5")).toThrow(/positive integer/);
    expect(() => parseMaxTurns("lots")).toThrow(/positive integer/);
  });
});

describe("createTurnCounter", () => {
  const assistantTurn = (id: string) => [
    { type: "reasoning", id, text: "thinking", session_id: "s" },
    { type: "message", role: "assistant", id, text: "hi", session_id: "s" },
    { type: "tool_call", id: `${id}-call-1`, messageId: id, toolId: "Read" },
    { type: "tool_call", id: `${id}-call-2`, messageId: id, toolId: "Grep" },
  ];

  test("counts one turn per assistant message across its fan-out events", () => {
    const counter = createTurnCounter();

    for (const event of assistantTurn("m1")) counter.observe(event);
    expect(counter.count).toBe(1);

    for (const event of assistantTurn("m2")) counter.observe(event);
    expect(counter.count).toBe(2);
  });

  test("ignores user messages, tool results, system and result events", () => {
    const counter = createTurnCounter();

    counter.observe({ type: "system", subtype: "init", session_id: "s" });
    counter.observe({ type: "message", role: "user", id: "u1", text: "go" });
    counter.observe({ type: "tool_result", id: "m1-call-1", value: "ok" });
    counter.observe({ type: "result", num_turns: 12 });
    counter.observe("not an object");
    counter.observe(null);

    expect(counter.count).toBe(0);
  });

  test("returns the running count from observe", () => {
    const counter = createTurnCounter();

    expect(counter.observe(assistantTurn("m1")[1])).toBe(1);
    expect(counter.observe(assistantTurn("m1")[2])).toBe(1);
    expect(counter.observe(assistantTurn("m2")[2])).toBe(2);
  });
});
