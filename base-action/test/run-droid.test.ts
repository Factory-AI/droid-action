#!/usr/bin/env bun

import { describe, test, expect } from "bun:test";
import { prepareRunConfig, type DroidOptions } from "../src/run-droid";

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
});
