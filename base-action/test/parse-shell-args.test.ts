import { describe, expect, test } from "bun:test";
import { parse as parseShellArgs } from "shell-quote";

describe("shell-quote parseShellArgs", () => {
  test("should handle empty input", () => {
    expect(parseShellArgs("")).toEqual([]);
    expect(parseShellArgs("   ")).toEqual([]);
  });

  test("should parse simple arguments", () => {
    expect(parseShellArgs("--auto medium")).toEqual(["--auto", "medium"]);
    expect(parseShellArgs("-s session-123")).toEqual(["-s", "session-123"]);
  });

  test("should handle double quotes", () => {
    expect(parseShellArgs('--file "/tmp/prompt.md"')).toEqual([
      "--file",
      "/tmp/prompt.md",
    ]);
    expect(parseShellArgs('"arg with spaces"')).toEqual(["arg with spaces"]);
  });

  test("should handle single quotes", () => {
    expect(parseShellArgs("--file '/tmp/prompt.md'")).toEqual([
      "--file",
      "/tmp/prompt.md",
    ]);
    expect(parseShellArgs("'arg with spaces'")).toEqual(["arg with spaces"]);
  });
  test("should handle escaped characters", () => {
    expect(parseShellArgs("arg\\ with\\ spaces")).toEqual(["arg with spaces"]);
    expect(parseShellArgs('arg\\"with\\"quotes')).toEqual(['arg"with"quotes']);
  });

  test("should handle mixed quotes", () => {
    expect(parseShellArgs(`--enabled-tools "ApplyPatch,Read"`)).toEqual([
      "--enabled-tools",
      "ApplyPatch,Read",
    ]);
    expect(parseShellArgs(`--reasoning-effort 'low'`)).toEqual([
      "--reasoning-effort",
      "low",
    ]);
    expect(parseShellArgs(`-r 'medium'`)).toEqual(["-r", "medium"]);
  });

  test("should handle mixed quotes with prompt text", () => {
    expect(parseShellArgs(`--model "gpt-5.1-codex" "fix the bug"`)).toEqual([
      "--model",
      "gpt-5.1-codex",
      "fix the bug",
    ]);
  });

  test("should handle complex real-world example", () => {
    const input = `--model gpt-5.1-codex --auto low --enabled-tools Read,ApplyPatch`;
    expect(parseShellArgs(input)).toEqual([
      "--model",
      "gpt-5.1-codex",
      "--auto",
      "low",
      "--enabled-tools",
      "Read,ApplyPatch",
    ]);
  });

  test("should filter out non-string results", () => {
    // shell-quote can return objects for operators like | > < etc
    const result = parseShellArgs("echo hello");
    const filtered = result.filter((arg) => typeof arg === "string");
    expect(filtered).toEqual(["echo", "hello"]);
  });
});
