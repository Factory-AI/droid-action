import { describe, expect, it, spyOn, afterEach } from "bun:test";
import {
  createLogger,
  resolveLogFormat,
  resolveLogLevel,
  type LogEntry,
} from "../src/logger";

function capturingSink(entries: LogEntry[]) {
  return (entry: LogEntry) => {
    entries.push(entry);
  };
}

afterEach(() => {
  // Spies created in individual tests are restored here so later tests see
  // the real console methods.
});

describe("structured logger", () => {
  it("emits one entry with ts, level, module and msg", () => {
    const entries: LogEntry[] = [];
    const log = createLogger("test/basic", { sink: capturingSink(entries) });

    log.info("hello");

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.level).toBe("info");
    expect(entry.module).toBe("test/basic");
    expect(entry.msg).toBe("hello");
    expect(!Number.isNaN(Date.parse(entry.ts))).toBe(true);
  });

  it("filters entries below the configured level", () => {
    const entries: LogEntry[] = [];
    const log = createLogger("test/level", {
      level: "warn",
      sink: capturingSink(entries),
    });

    log.debug("debug");
    log.info("info");
    log.warn("warn");
    log.error("error");

    expect(entries.map((entry) => entry.level)).toEqual(["warn", "error"]);
  });

  it("serializes a single Error detail into an error field", () => {
    const entries: LogEntry[] = [];
    const log = createLogger("test/error-detail", {
      sink: capturingSink(entries),
    });
    const error = new Error("boom");

    log.error("operation failed", error);

    const entry = entries[0]!;
    expect(entry.msg).toBe("operation failed");
    expect(entry.error).toEqual({
      name: "Error",
      message: "boom",
      stack: error.stack,
    });
  });

  it("merges a plain object detail as fields and serializes nested Errors", () => {
    const entries: LogEntry[] = [];
    const log = createLogger("test/fields", { sink: capturingSink(entries) });
    const error = new Error("nested");

    log.error("exchange failed", { status: 500, error });

    const entry = entries[0]!;
    expect(entry.status).toBe(500);
    expect((entry.error as { message: string }).message).toBe("nested");
    expect((entry.error as { name: string }).name).toBe("Error");
  });

  it("collects multiple details into a details array", () => {
    const entries: LogEntry[] = [];
    const log = createLogger("test/details", { sink: capturingSink(entries) });

    log.error("failed", "attempt 2", 42, new Error("x"));

    const details = entries[0]!.details as unknown[];
    expect(details).toHaveLength(3);
    expect(details[0]).toBe("attempt 2");
    expect(details[1]).toBe(42);
    expect(details[2]).toMatchObject({ message: "x" });
  });

  it("accepts an Error as the message, for promise catch handlers", () => {
    const entries: LogEntry[] = [];
    const log = createLogger("test/error-message", {
      sink: capturingSink(entries),
    });
    const error = new Error("rejected");

    log.error(error);

    const entry = entries[0]!;
    expect(entry.msg).toBe("rejected");
    expect((entry.error as { message: string }).message).toBe("rejected");
  });

  it("stringifies non-string, non-Error messages", () => {
    const entries: LogEntry[] = [];
    const log = createLogger("test/odd-message", {
      sink: capturingSink(entries),
    });

    log.info(42);

    const entry = entries[0]!;
    expect(entry.msg).toBe("42");
    expect(entry.detail).toBe(42);
  });

  it("adds child bindings to every entry", () => {
    const entries: LogEntry[] = [];
    const log = createLogger("test/child", { sink: capturingSink(entries) });
    const child = log.child({ pr: 7 });

    child.info("hello");

    expect(entries[0]!.pr).toBe(7);
  });

  it("resolves the level from the environment", () => {
    expect(resolveLogLevel({ DROID_LOG_LEVEL: "warn" })).toBe("warn");
    expect(resolveLogLevel({ DROID_LOG_LEVEL: "WARN" })).toBe("warn");
    expect(resolveLogLevel({ DROID_LOG_LEVEL: "not-a-level" })).toBe("info");
    expect(resolveLogLevel({ RUNNER_DEBUG: "1" })).toBe("debug");
    expect(resolveLogLevel({ ACTIONS_STEP_DEBUG: "true" })).toBe("debug");
    expect(resolveLogLevel({})).toBe("info");
  });

  it("resolves the format from the environment", () => {
    expect(resolveLogFormat({ DROID_LOG_FORMAT: "text" })).toBe("text");
    expect(resolveLogFormat({ DROID_LOG_FORMAT: "TEXT" })).toBe("text");
    expect(resolveLogFormat({ DROID_LOG_FORMAT: "json" })).toBe("json");
    expect(resolveLogFormat({})).toBe("json");
  });
});

describe("structured logger default sink", () => {
  it("routes levels to the matching console stream", () => {
    const info = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger("test/sink");

    log.info("info line");
    log.warn("warn line");
    log.error("error line");

    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    const infoLine = String(info.mock.calls[0]?.[0]);
    const parsed = JSON.parse(infoLine) as LogEntry;
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("info line");

    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it("writes a readable text line when DROID_LOG_FORMAT=text", () => {
    const info = spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("test/text", { format: "text" });

    log.info("hello", { attempt: 2 });

    const line = String(info.mock.calls[0]?.[0]);
    expect(line).toContain("[test/text]");
    expect(line).toContain("INFO");
    expect(line).toContain("hello");
    expect(line).toContain("attempt=2");

    info.mockRestore();
  });

  it("falls back to core entry fields when fields are not serializable", () => {
    const info = spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("test/circular");
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    log.info("unserializable", circular);

    const parsed = JSON.parse(String(info.mock.calls[0]?.[0])) as LogEntry;
    expect(parsed.msg).toBe("unserializable");
    expect(parsed.note).toBe("log fields were not serializable");

    info.mockRestore();
  });
});
