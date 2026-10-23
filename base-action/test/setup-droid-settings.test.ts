#!/usr/bin/env bun

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { setupDroidSettings } from "../src/setup-droid-settings";
import { tmpdir } from "os";
import { mkdir, writeFile, readFile, rm, stat } from "fs/promises";
import { join } from "path";

const testHomeDir = join(
  tmpdir(),
  "droid-exec-test-home",
  Date.now().toString(),
);
const settingsPath = join(testHomeDir, ".factory", "droid", "settings.json");
const testSettingsDir = join(testHomeDir, ".factory-test");
const testSettingsPath = join(testSettingsDir, "test-settings.json");

async function readSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsPath, "utf-8"));
}

describe("setupDroidSettings", () => {
  beforeEach(async () => {
    // Create test home directory and test settings directory
    await mkdir(testHomeDir, { recursive: true });
    await mkdir(testSettingsDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test home directory
    await rm(testHomeDir, { recursive: true, force: true });
  });

  test("writes an empty owner-only settings file when no input", async () => {
    await setupDroidSettings(undefined, testHomeDir);

    expect(await readSettings()).toEqual({});
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
  });

  test("should merge settings from JSON string input", async () => {
    const inputSettings = JSON.stringify({
      model: "gpt-5-codex",
      env: { API_KEY: "test-key" },
    });

    await setupDroidSettings(inputSettings, testHomeDir);

    const settings = await readSettings();
    expect(settings.model).toBe("gpt-5-codex");
    expect(settings.env).toEqual({ API_KEY: "test-key" });
  });

  test("should merge settings from file path input", async () => {
    const testSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo test" }],
          },
        ],
      },
      permissions: {
        allow: ["Bash", "Read"],
      },
    };

    await writeFile(testSettingsPath, JSON.stringify(testSettings, null, 2));

    await setupDroidSettings(testSettingsPath, testHomeDir);

    const settings = await readSettings();
    expect(settings.hooks).toEqual(testSettings.hooks);
    expect(settings.permissions).toEqual(testSettings.permissions);
  });

  test("does not force enableAllProjectMcpServers on", async () => {
    await setupDroidSettings(
      JSON.stringify({ enableAllProjectMcpServers: false, model: "m" }),
      testHomeDir,
    );

    const settings = await readSettings();
    expect(settings.enableAllProjectMcpServers).toBe(false);
    expect(settings.model).toBe("m");
  });

  test("never logs setting values", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const secret = "settings-secret-value-123456";
      await setupDroidSettings(
        JSON.stringify({ env: { API_KEY: secret } }),
        testHomeDir,
      );
      // The second run finds the first run's file and reports on it.
      await setupDroidSettings(undefined, testHomeDir);

      const logged = logSpy.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("env");
      expect(logged).not.toContain(secret);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("does not echo a malformed JSON value", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const secret = "settings-secret-value-123456";
      await expect(
        setupDroidSettings(`{ "env": { "KEY": "${secret}" ,}`, testHomeDir),
      ).rejects.toThrow();

      const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls]
        .flat()
        .map(String)
        .join("\n");
      expect(logged).not.toContain(secret);
      const error = await setupDroidSettings(
        `{ "env": { "KEY": "${secret}" ,}`,
        testHomeDir,
      ).catch((e: unknown) => e);
      expect(String(error)).not.toContain(secret);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("should throw error for invalid JSON string", async () => {
    expect(() => setupDroidSettings("{ invalid json", testHomeDir)).toThrow();
  });

  test("should throw error for non-existent file path", async () => {
    expect(() =>
      setupDroidSettings("/non/existent/file.json", testHomeDir),
    ).toThrow();
  });

  test("should handle empty string input", async () => {
    await setupDroidSettings("", testHomeDir);

    expect(await readSettings()).toEqual({});
  });

  test("should handle whitespace-only input", async () => {
    await setupDroidSettings("   \n\t  ", testHomeDir);

    expect(await readSettings()).toEqual({});
  });

  test("should merge with existing settings", async () => {
    // First, create some existing settings
    await setupDroidSettings(
      JSON.stringify({ existingKey: "existingValue" }),
      testHomeDir,
    );

    // Then, add new settings
    const newSettings = JSON.stringify({
      newKey: "newValue",
      model: "gpt-5-codex",
    });

    await setupDroidSettings(newSettings, testHomeDir);

    const settings = await readSettings();
    expect(settings.existingKey).toBe("existingValue");
    expect(settings.newKey).toBe("newValue");
    expect(settings.model).toBe("gpt-5-codex");
  });
});
