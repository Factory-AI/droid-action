import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { z } from "zod";
import { RiskError } from "./types";

export type RiskStep = "begin" | "settle";

export type RiskCallInput = { request: unknown; oidcToken?: string };

const RiskCallOutputSchema = z.union([
  z.object({ status: z.number().int(), body: z.unknown() }),
  z.object({ error: z.string(), message: z.string() }),
]);
/**
 * What the CLI printed, or a request this side gave up on (the CLI was
 * stopped), which the caller retries like one that got no answer.
 */
export type RiskCallOutput =
  | z.infer<typeof RiskCallOutputSchema>
  | { error: "request_failed" };

/** One risk step, sent by the Droid CLI. */
export type RiskCall = (
  step: RiskStep,
  input: RiskCallInput,
) => Promise<RiskCallOutput>;

/** The CLI's own request deadlines (60 s and 90 s) plus room to start. */
const STEP_TIMEOUT_MS: Record<RiskStep, number> = {
  begin: 75_000,
  settle: 105_000,
};
/** Bounds what is held in memory; a larger answer is reported, not parsed. */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

/**
 * Hosts the CLI may be pointed at for testing. The CLI refuses any of them
 * that is not https on factory.ai, so passing them on cannot move the key.
 */
const PASSED_HOST_VARIABLES = [
  "FACTORY_API_BASE_URL",
  "FACTORY_API_BASE_URL_EU",
] as const;

/**
 * Runs `droid risk <step>`, which sends the request with the API key to the
 * Factory host the CLI resolves and only there. The child gets the key, a
 * home for its configuration and nothing else of the job, and runs outside
 * the checkout so no `.env` there reaches it.
 */
export function droidRiskCall(options: {
  droidBinary: string;
  apiKey: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): RiskCall {
  const source = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    ...(source.HOME ? { HOME: source.HOME } : {}),
    FACTORY_API_KEY: options.apiKey,
  };
  for (const name of PASSED_HOST_VARIABLES) {
    if (source[name]) env[name] = source[name];
  }

  return (step, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(options.droidBinary, ["risk", step], {
        cwd: tmpdir(),
        env,
        stdio: ["pipe", "pipe", "ignore"],
      });
      // Tracked here rather than read from the exit signal: the CLI handles
      // SIGTERM itself and can exit 143 with no signal reported.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs ?? STEP_TIMEOUT_MS[step]);
      const chunks: Buffer[] = [];
      let bytes = 0;
      let overflowed = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (overflowed) return;
        bytes += chunk.byteLength;
        if (bytes > MAX_STDOUT_BYTES) {
          overflowed = true;
          child.kill("SIGTERM");
          return;
        }
        chunks.push(chunk);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new RiskError(
            "droid_unavailable",
            `The Droid CLI could not be started (${error.code ?? error.name})`,
          ),
        );
      });
      child.on("close", (_code, signal) => {
        clearTimeout(timer);
        if (overflowed) {
          reject(
            new RiskError(
              "droid_risk_output_too_large",
              `The answer to \`droid risk ${step}\` was larger than ${MAX_STDOUT_BYTES} bytes`,
            ),
          );
          return;
        }
        if (timedOut || signal) {
          resolve({ error: "request_failed" });
          return;
        }
        const line = Buffer.concat(chunks)
          .toString("utf8")
          .trim()
          .split("\n")
          .at(-1);
        let parsed: z.SafeParseReturnType<unknown, RiskCallOutput> | undefined;
        try {
          parsed = RiskCallOutputSchema.safeParse(JSON.parse(line ?? ""));
        } catch {
          // Not JSON: the CLI does not know the command.
        }
        if (parsed?.success) {
          resolve(parsed.data);
          return;
        }
        reject(
          new RiskError(
            "droid_risk_unavailable",
            `The Droid CLI gave no answer to \`droid risk ${step}\`; it may predate the command. Update the Droid CLI.`,
          ),
        );
      });
      child.stdin.on("error", () => {
        // The child exited before reading; its exit reports the failure.
      });
      child.stdin.end(JSON.stringify(input));
    });
}
