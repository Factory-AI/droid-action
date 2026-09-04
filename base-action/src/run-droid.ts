import * as core from "@actions/core";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { stat } from "fs/promises";
import { parse as parseShellArgs } from "shell-quote";
import { retryWithBackoff } from "./utils/retry";
import {
  condenseInvalidModelError,
  isInvalidModelError,
  isModelPolicyError,
  stripModelArgs,
} from "./utils/model-policy-error";

const execAsync = promisify(exec);

/** Redact inline `--env KEY=value` secrets before logging a command string. */
function redactEnvSecrets(text: string): string {
  return text.replace(/--env\s+(\S+?)=\S+/g, "--env $1=***");
}

const BASE_ARGS = [
  "exec",
  "--output-format",
  "stream-json",
  "--skip-permissions-unsafe",
];

/**
 * Sanitizes JSON output to remove sensitive information when full output is disabled
 * Returns a safe summary message or null if the message should be completely suppressed
 */
function sanitizeJsonOutput(
  jsonObj: any,
  showFullOutput: boolean,
): string | null {
  if (showFullOutput) {
    // In full output mode, return the full JSON
    return JSON.stringify(jsonObj, null, 2);
  }

  // In non-full-output mode, provide minimal safe output
  const type = jsonObj.type;
  const subtype = jsonObj.subtype;

  // System initialization - safe to show
  if (type === "system" && subtype === "init") {
    return JSON.stringify(
      {
        type: "system",
        subtype: "init",
        message: "Droid Exec initialized",
        model: jsonObj.model || "unknown",
      },
      null,
      2,
    );
  }

  // Result messages - Always show the final result
  if (type === "result") {
    // These messages contain the final result and should always be visible
    return JSON.stringify(
      {
        type: "result",
        subtype: jsonObj.subtype,
        is_error: jsonObj.is_error,
        duration_ms: jsonObj.duration_ms,
        num_turns: jsonObj.num_turns,
        total_cost_usd: jsonObj.total_cost_usd,
        permission_denials: jsonObj.permission_denials,
      },
      null,
      2,
    );
  }

  // For any other message types, suppress completely in non-full-output mode
  return null;
}

export type DroidOptions = {
  droidArgs?: string;
  reasoningEffort?: string;
  pathToDroidExecutable?: string;
  allowedTools?: string;
  disallowedTools?: string;
  /**
   * Upper bound on assistant turns before the run is aborted. Enforced here
   * by watching the stream-json output, since `droid exec` has no turn limit
   * of its own. Empty disables the cap.
   */
  maxTurns?: string;
  mcpTools?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  showFullOutput?: string;
};

type PreparedConfig = {
  droidArgs: string[];
  promptPath: string;
  env: Record<string, string>;
};

export function parseMaxTurns(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `max_turns must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

/**
 * Counts assistant turns in `droid exec --output-format stream-json` output.
 *
 * One assistant turn fans out into several events (`reasoning`, `message`,
 * `tool_call`) that share the assistant message id (`messageId` on
 * tool_call, `id` on the others), so turns are counted as distinct ids.
 * Subagents run as separate processes and never appear on this stream, so
 * the count covers the root session only.
 */
export function createTurnCounter() {
  const seen = new Set<string>();
  return {
    get count() {
      return seen.size;
    },
    /** Returns the turn count after observing `event`. */
    observe(event: unknown): number {
      if (typeof event !== "object" || event === null) return seen.size;
      const e = event as Record<string, unknown>;
      let id: unknown;
      if (e.type === "tool_call") {
        id = e.messageId;
      } else if (
        (e.type === "message" && e.role === "assistant") ||
        e.type === "reasoning"
      ) {
        id = e.id;
      }
      if (typeof id === "string" && id) {
        seen.add(id);
      }
      return seen.size;
    },
  };
}

export class MaxTurnsExceededError extends Error {
  constructor(public readonly maxTurns: number) {
    super(
      `Droid Exec exceeded the maximum of ${maxTurns} turns and was stopped. ` +
        "This usually means the agent got stuck in a loop.",
    );
    this.name = "MaxTurnsExceededError";
  }
}

export function prepareRunConfig(
  promptPath: string,
  options: DroidOptions,
): PreparedConfig {
  const droidArgs = [...BASE_ARGS];

  // Add reasoning effort only when explicitly requested
  if (options.reasoningEffort?.trim()) {
    droidArgs.push("--reasoning-effort", options.reasoningEffort.trim());
  }

  // Parse and add user's custom Droid arguments
  if (options.droidArgs?.trim()) {
    const parsed = parseShellArgs(options.droidArgs);
    const customArgs = parsed.filter(
      (arg): arg is string => typeof arg === "string",
    );
    droidArgs.push(...customArgs);
  }

  droidArgs.push("-f", promptPath);

  const customEnv: Record<string, string> = {};

  if (process.env.INPUT_ACTION_INPUTS_PRESENT) {
    customEnv.GITHUB_ACTION_INPUTS = process.env.INPUT_ACTION_INPUTS_PRESENT;
  }

  return {
    droidArgs,
    promptPath,
    env: customEnv,
  };
}

export async function runDroid(promptPath: string, options: DroidOptions) {
  // If MCP tools config is provided, register servers via `droid mcp add` before running exec
  if (options.mcpTools && options.mcpTools.trim()) {
    try {
      const cfg = JSON.parse(options.mcpTools);
      const servers = cfg?.mcpServers || {};
      const serverNames = Object.keys(servers);

      if (serverNames.length > 0) {
        console.log(
          `Registering ${serverNames.length} MCP servers: ${serverNames.join(", ")}`,
        );

        for (const [name, def] of Object.entries<any>(servers)) {
          const cmd = [def.command, ...(def.args || [])]
            .filter(Boolean)
            .join(" ");

          // Build env flags
          const envFlags = Object.entries(def.env || {})
            .map(([k, v]) => `--env ${k}=${String(v)}`)
            .join(" ");

          const addCmd = `droid mcp add ${name} "${cmd}" ${envFlags}`.trim();

          try {
            await retryWithBackoff(
              async () => {
                // Remove existing server if present (ignore errors) before each attempt
                try {
                  await execAsync(`droid mcp remove ${name}`);
                } catch (_) {
                  // Ignore - server might not exist
                }
                try {
                  await execAsync(addCmd, { env: { ...process.env } });
                } catch (err) {
                  // Redact inline --env secrets before they reach any log or rethrow.
                  const message =
                    err instanceof Error ? err.message : String(err);
                  throw new Error(redactEnvSecrets(message));
                }
              },
              { maxAttempts: 3, initialDelayMs: 2000, maxDelayMs: 10000 },
            );
            console.log(`  ✓ Registered MCP server: ${name}`);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.error(
              `  ✗ Failed to register MCP server ${name}:`,
              message,
            );
            throw new Error(message);
          }
        }
      }
    } catch (e) {
      console.error("Failed to register MCP servers:", e);
      // Don't continue without MCP if we were expecting it
      throw new Error(`MCP server registration failed: ${e}`);
    }
  }

  const config = prepareRunConfig(promptPath, options);

  // Log prompt file size
  let promptSize = "unknown";
  try {
    const stats = await stat(config.promptPath);
    promptSize = stats.size.toString();
  } catch (e) {
    // Ignore error
  }

  console.log(`Prompt file size: ${promptSize} bytes`);

  // Log custom environment variables if any
  const customEnvKeys = Object.keys(config.env).filter(
    (key) => key !== "DROID_ACTION_INPUTS_PRESENT",
  );
  if (customEnvKeys.length > 0) {
    console.log(`Custom environment variables: ${customEnvKeys.join(", ")}`);
  }

  // Log custom arguments if any
  if (options.droidArgs && options.droidArgs.trim() !== "") {
    console.log(`Custom Droid arguments: ${options.droidArgs}`);

    // Check for deprecated MCP tool naming
    const enabledToolsMatch = options.droidArgs.match(
      /--enabled-tools\s+["\']?([^"\']+)["\']?/,
    );
    if (enabledToolsMatch && enabledToolsMatch[1]) {
      const tools = enabledToolsMatch[1].split(",").map((t) => t.trim());
      const oldStyleTools = tools.filter((t) => t.startsWith("mcp__"));

      if (oldStyleTools.length > 0) {
        console.warn(
          `Warning: Found ${oldStyleTools.length} tools with deprecated mcp__ prefix. Update to new pattern (e.g., github_comment___update_droid_comment)`,
        );
      }
    }
  }

  // Output to console
  console.log(`Running Droid Exec with prompt from file: ${config.promptPath}`);
  console.log(`Full command: droid ${config.droidArgs.join(" ")}`);

  // Use custom executable path if provided, otherwise default to "droid"
  const droidExecutable = options.pathToDroidExecutable || "droid";

  // Determine if full output should be shown
  // Show full output if explicitly set to "true" OR if GitHub Actions debug mode is enabled
  const isDebugMode = process.env.ACTIONS_STEP_DEBUG === "true";
  let showFullOutput = options.showFullOutput === "true" || isDebugMode;

  if (isDebugMode && options.showFullOutput !== "false") {
    console.log("Debug mode detected - showing full output");
    showFullOutput = true;
  } else if (!showFullOutput) {
    console.log("Running Droid Exec (full output hidden for security)...");
    console.log(
      "Rerun in debug mode or enable `show_full_output: true` in your workflow file for full output.",
    );
  }

  const maxTurns = parseMaxTurns(options.maxTurns);
  if (maxTurns !== null) {
    console.log(`Turn limit: ${maxTurns}`);
  }

  // Run Droid Exec with retry for transient failures. Uses the shared
  // retryWithBackoff so backoff timing lives in one place (3 total attempts,
  // 5s then 10s delays).
  let lastExitCode = 1;
  let currentDroidArgs = config.droidArgs;
  let modelArgsStripped = false;
  type ResultEvent = { is_error?: boolean; result?: string };
  let lastResultEvent: ResultEvent | null = null;
  // Fast client-side failures (e.g. an invalid --model value) print to
  // stderr and exit before any stream-json result event is emitted, so keep
  // a bounded tail of stderr as an error-message fallback.
  const STDERR_TAIL_LIMIT = 1500;
  let stderrTail = "";
  // Indirection defeats TS control-flow narrowing: the variables are only
  // assigned inside stream handler closures, so direct reads after the
  // retry loop would otherwise be narrowed to their initial values.
  const getLastResultEvent = (): ResultEvent | null => lastResultEvent;
  const getStderrTail = (): string => stderrTail;

  const runDroidOnce = (): Promise<number> => {
    stderrTail = "";
    const turns = createTurnCounter();
    let turnLimitHit = false;
    const droidProcess = spawn(droidExecutable, currentDroidArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...config.env,
      },
    });

    const stopForTurnLimit = () => {
      if (turnLimitHit) return;
      turnLimitHit = true;
      console.error(
        `Droid Exec reached the turn limit (${maxTurns}); stopping the process`,
      );
      droidProcess.kill("SIGTERM");
      // Give the CLI a moment to flush and exit cleanly before forcing it.
      const forceKill = setTimeout(() => {
        if (droidProcess.exitCode === null) {
          droidProcess.kill("SIGKILL");
        }
      }, 5000);
      forceKill.unref();
    };

    droidProcess.stderr.on("data", (data) => {
      const text = data.toString();
      process.stderr.write(text);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
    });

    droidProcess.stderr.on("error", (error) => {
      console.error("Error reading Droid stderr:", error);
    });

    // Handle Droid process errors
    droidProcess.on("error", (error) => {
      console.error("Error spawning Droid process:", error);
    });

    // Capture output for parsing execution metrics
    let sessionId: string | undefined;
    let stdoutBuffer = "";
    const handleStdoutLine = (line: string): void => {
      if (line.trim() === "") return;

      try {
        const parsed = JSON.parse(line);
        if (!sessionId && typeof parsed === "object" && parsed !== null) {
          const detectedSessionId = parsed.session_id;
          if (
            typeof detectedSessionId === "string" &&
            detectedSessionId.trim()
          ) {
            sessionId = detectedSessionId;
            console.log(`Detected Droid session: ${sessionId}`);
          }
        }
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          parsed.type === "result"
        ) {
          lastResultEvent = {
            is_error: parsed.is_error === true,
            result:
              typeof parsed.result === "string" ? parsed.result : undefined,
          };
        }
        if (
          maxTurns !== null &&
          !turnLimitHit &&
          turns.observe(parsed) > maxTurns
        ) {
          stopForTurnLimit();
        }
        const sanitizedOutput = sanitizeJsonOutput(parsed, showFullOutput);

        if (sanitizedOutput) {
          process.stdout.write(`${sanitizedOutput}\n`);
        }
      } catch {
        // Not a JSON object
        if (showFullOutput) {
          process.stdout.write(`${line}\n`);
        }
        // In non-full-output mode, suppress non-JSON output
      }
    };

    droidProcess.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        handleStdoutLine(line);
      }
    });

    droidProcess.stdout.on("end", () => {
      if (stdoutBuffer) {
        handleStdoutLine(stdoutBuffer);
        stdoutBuffer = "";
      }
    });

    // Handle stdout errors
    droidProcess.stdout.on("error", (error) => {
      console.error("Error reading Droid stdout:", error);
    });

    // Wait for Droid Exec to finish
    return new Promise<number>((resolve, reject) => {
      droidProcess.on("close", (code) => {
        if (turnLimitHit) {
          reject(new MaxTurnsExceededError(maxTurns!));
          return;
        }
        resolve(code || 0);
      });

      droidProcess.on("error", (error) => {
        console.error("Droid process error:", error);
        resolve(1);
      });
    });
  };

  let turnCapError: MaxTurnsExceededError | null = null;
  const getTurnCapError = (): MaxTurnsExceededError | null => turnCapError;

  try {
    await retryWithBackoff(
      async () => {
        try {
          lastExitCode = await runDroidOnce();
        } catch (error) {
          if (error instanceof MaxTurnsExceededError) {
            turnCapError = error;
            lastExitCode = 1;
          }
          throw error;
        }
        if (lastExitCode !== 0) {
          console.log(`Droid Exec exited with code ${lastExitCode}`);
          // If the failure was caused by the requested model being rejected
          // (blocked by the org's model policy, or not a recognized model
          // id), retry without --model so droid exec falls back to the
          // organization's default model.
          const resultEvent = getLastResultEvent();
          const policyBlocked =
            resultEvent?.is_error === true &&
            isModelPolicyError(resultEvent.result);
          const invalidModel = isInvalidModelError(getStderrTail());
          if (
            !modelArgsStripped &&
            (policyBlocked || invalidModel) &&
            currentDroidArgs.some(
              (arg) => arg === "--model" || arg.startsWith("--model="),
            )
          ) {
            modelArgsStripped = true;
            currentDroidArgs = stripModelArgs(currentDroidArgs);
            const reason = policyBlocked
              ? "is not allowed by your organization's model policy"
              : "is not a recognized model id";
            console.warn(
              `The requested model ${reason}; retrying with the organization's default model`,
            );
            core.setOutput(
              "model_fallback_note",
              `The requested model ${reason}, so Droid retried with your organization's default model. ` +
                "Set the model input (e.g. `review_model`) to an " +
                "[available model](https://docs.factory.ai/models) approved " +
                "by your organization to control which model is used.",
            );
          }
          throw new Error(`Droid Exec exited with code ${lastExitCode}`);
        }
      },
      {
        maxAttempts: 3,
        initialDelayMs: 5000,
        maxDelayMs: 20000,
        // A runaway agent is not a transient failure; re-running it would
        // only repeat the loop.
        shouldRetry: (error) => !(error instanceof MaxTurnsExceededError),
      },
    );
    core.setOutput("conclusion", "success");
    return;
  } catch (_) {
    const capError = getTurnCapError();
    if (!capError) {
      // All retry attempts exhausted
      console.error(
        `Droid Exec failed after 3 total attempts (exit code: ${lastExitCode})`,
      );
    }
    const finalResultEvent = getLastResultEvent();
    let finalStderrTail = getStderrTail().trim();
    if (isInvalidModelError(finalStderrTail)) {
      finalStderrTail = condenseInvalidModelError(finalStderrTail);
    }
    const rawErrorMessage = capError
      ? capError.message
      : finalResultEvent?.is_error && finalResultEvent.result?.trim()
        ? finalResultEvent.result.trim()
        : finalStderrTail
          ? `Droid Exec exited with code ${lastExitCode}:\n${finalStderrTail}`
          : `Droid Exec exited with code ${lastExitCode}`;
    const errorMessage =
      rawErrorMessage.length > 2000
        ? `${rawErrorMessage.slice(0, 2000)}…`
        : rawErrorMessage;
    console.error(`Droid Exec failed: ${errorMessage}`);
    core.setOutput("error_message", errorMessage);
    core.setOutput("conclusion", "failure");
    process.exit(lastExitCode);
  }
}
