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
export type RiskCallOutput = z.infer<typeof RiskCallOutputSchema>;

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
const MAX_STDOUT_BYTES = 1024 * 1024;

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
        timeout: STEP_TIMEOUT_MS[step],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes <= MAX_STDOUT_BYTES) chunks.push(chunk);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        reject(
          new RiskError(
            "droid_unavailable",
            `The Droid CLI could not be started (${error.code ?? error.name})`,
          ),
        );
      });
      child.on("close", (_code, signal) => {
        if (signal) {
          resolve({
            error: "request_failed",
            message: `droid risk ${step} did not finish (${signal})`,
          });
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
