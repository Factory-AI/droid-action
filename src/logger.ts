/**
 * Structured logger for the Droid GitHub action.
 *
 * Every entry is a single line: a JSON object by default, or a readable text
 * line when DROID_LOG_FORMAT=text. JSON keeps workflow logs machine-parseable
 * for CI analytics, while warn/error still write to stderr so the stdio-based
 * MCP servers can log without corrupting their protocol channel.
 *
 * Configuration (environment):
 *   DROID_LOG_LEVEL   debug | info | warn | error (default: info; debug when
 *                      RUNNER_DEBUG=1 or ACTIONS_STEP_DEBUG=true)
 *   DROID_LOG_FORMAT  json | text (default: json)
 *
 * Secrets registered with @actions/core#setSecret stay safe: the Actions
 * runner masks them in raw stdout/stderr, including inside JSON entries.
 *
 * Usage:
 *   const log = createLogger("github/token");
 *   log.info("Exchanging OIDC token for app token");
 *   log.error("Token exchange failed", { status: response.status });
 *   log.error("Unexpected failure", error); // Error detail is serialized
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type LogEntry = {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
} & LogFields;

export type LogFormat = "json" | "text";

export type LogSink = (entry: LogEntry) => void;

export type LoggerOptions = {
  level?: LogLevel;
  format?: LogFormat;
  sink?: LogSink;
};

export interface Logger {
  debug(message: unknown, ...details: unknown[]): void;
  info(message: unknown, ...details: unknown[]): void;
  warn(message: unknown, ...details: unknown[]): void;
  error(message: unknown, ...details: unknown[]): void;
  /** Returns a logger whose entries include the given fields on every call. */
  child(bindings: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_NAMES = Object.keys(LEVEL_ORDER) as LogLevel[];

export function resolveLogLevel(
  env: Record<string, string | undefined> = process.env,
): LogLevel {
  const requested = env.DROID_LOG_LEVEL?.toLowerCase();
  if (requested && LEVEL_NAMES.includes(requested as LogLevel)) {
    return requested as LogLevel;
  }
  if (env.RUNNER_DEBUG === "1" || env.ACTIONS_STEP_DEBUG === "true") {
    return "debug";
  }
  return "info";
}

export function resolveLogFormat(
  env: Record<string, string | undefined> = process.env,
): LogFormat {
  return env.DROID_LOG_FORMAT?.toLowerCase() === "text" ? "text" : "json";
}

type SerializedError = { name: string; message: string; stack?: string };

function serializeError(error: Error): SerializedError {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
}

function isPlainObject(value: unknown): value is LogFields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function serializeDetail(value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  if (isPlainObject(value)) return value;
  if (typeof value === "object") return String(value);
  return value;
}

/**
 * Accepts the shapes this codebase historically passed to console.*:
 * a message alone, a message plus an Error (or any thrown value), a message
 * plus a fields object, or a message plus arbitrary extra values.
 */
function normalize(
  message: unknown,
  details: unknown[],
): { msg: string; fields: LogFields } {
  const fields: LogFields = {};
  let msg: string;

  if (message instanceof Error) {
    // Supports `promise.catch(log.error)` where the rejection arrives as the
    // first argument.
    fields.error = serializeError(message);
    msg = message.message;
  } else if (typeof message === "string") {
    msg = message;
  } else {
    msg = String(message);
    fields.detail = serializeDetail(message);
  }

  if (details.length === 1) {
    const detail = details[0] as unknown;
    if (detail !== undefined) {
      if (detail instanceof Error) {
        fields.error = serializeError(detail);
      } else if (isPlainObject(detail)) {
        // Field values pass through serializeDetail so Errors nested inside
        // a fields object still serialize with name/message instead of {}.
        for (const [key, value] of Object.entries(detail)) {
          fields[key] = serializeDetail(value);
        }
      } else {
        fields.detail = serializeDetail(detail);
      }
    }
  } else if (details.length > 0) {
    fields.details = details.map(serializeDetail);
  }

  return { msg, fields };
}

function stringifyEntry(entry: LogEntry): string {
  try {
    return JSON.stringify(entry);
  } catch {
    // Non-serializable field values (circular structures, BigInts) must not
    // break logging, so fall back to the core entry fields.
    return JSON.stringify({
      ts: entry.ts,
      level: entry.level,
      module: entry.module,
      msg: entry.msg,
      note: "log fields were not serializable",
    });
  }
}

const RESERVED_KEYS = new Set(["ts", "level", "module", "msg"]);

function formatText(entry: LogEntry): string {
  const extra = Object.entries(entry)
    .filter(([key]) => !RESERVED_KEYS.has(key))
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join(" ");
  const prefix = `${entry.ts} ${entry.level.toUpperCase().padEnd(5)} [${entry.module}]`;
  return extra ? `${prefix} ${entry.msg} ${extra}` : `${prefix} ${entry.msg}`;
}

// The default sink writes straight to console.* rather than through a Logger
// instance: routing it back through the logger would recurse forever.
function defaultSink(format: LogFormat): LogSink {
  return (entry) => {
    const line = format === "text" ? formatText(entry) : stringifyEntry(entry);
    if (entry.level === "error") {
      console.error(line);
    } else if (entry.level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  };
}

function makeLogger(
  module: string,
  bindings: LogFields,
  options: LoggerOptions,
): Logger {
  const configuredLevel = options.level ?? resolveLogLevel();
  const format = options.format ?? resolveLogFormat();
  const sink = options.sink ?? defaultSink(format);

  function emit(
    entryLevel: LogLevel,
    message: unknown,
    details: unknown[],
  ): void {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[configuredLevel]) return;
    const { msg, fields } = normalize(message, details);
    sink({
      ts: new Date().toISOString(),
      level: entryLevel,
      module,
      ...bindings,
      ...fields,
      msg,
    });
  }

  return {
    debug: (message: unknown, ...details: unknown[]) =>
      emit("debug", message, details),
    info: (message: unknown, ...details: unknown[]) =>
      emit("info", message, details),
    warn: (message: unknown, ...details: unknown[]) =>
      emit("warn", message, details),
    error: (message: unknown, ...details: unknown[]) =>
      emit("error", message, details),
    child: (childBindings: LogFields) =>
      makeLogger(module, { ...bindings, ...childBindings }, options),
  };
}

/** Creates a logger that tags every entry with the given module name. */
export function createLogger(
  module: string,
  options: LoggerOptions = {},
): Logger {
  return makeLogger(module, {}, options);
}
