import * as core from "@actions/core";
import { z } from "zod";
import { retryWithBackoff, type RetryOptions } from "../../utils/retry";
import {
  RISK_BEGIN_PATH,
  RISK_OIDC_AUDIENCE,
  RISK_OIDC_HEADER,
  RISK_SETTLE_PATH,
  RISK_WORKFLOW_NOT_TRUSTED,
  RiskBeginResponseSchema,
  RiskError,
  RiskSettleResponseSchema,
  type RiskBeginRequest,
  type RiskBeginResponse,
  type RiskFetch,
  type RiskSettleRequest,
  type RiskSettleResponse,
} from "./types";

const BEGIN_TIMEOUT_MS = 60_000;
const SETTLE_TIMEOUT_MS = 90_000;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

const ErrorBodySchema = z.object({
  detail: z.string().optional(),
  code: z.string().optional(),
});

export type RiskClientOptions = {
  baseUrl: string;
  apiKey: string;
  /**
   * Mints the OIDC token that proves which workflow is asking. Resolving to
   * undefined sends the request without one, which Factory accepts only for
   * a dry run.
   */
  getOidcToken?: () => Promise<string | undefined>;
  fetch?: RiskFetch;
  retry?: RetryOptions;
};

/** `status` is undefined when no HTTP answer arrived at all. */
class RiskRequestError extends RiskError {
  constructor(
    readonly status: number | undefined,
    readonly code: string | undefined,
    message: string,
  ) {
    super(status === undefined ? "request_failed" : `http_${status}`, message);
  }
}

/**
 * Requests the job's OIDC token for Factory. A dry run may go without one; a
 * real run fails here, where the missing permission can be named.
 */
export async function getRiskOidcToken(
  dryRun: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    if (dryRun) return undefined;
    throw new RiskError(
      "oidc_unavailable",
      "This job cannot request an OIDC token. Add `id-token: write` to the job's permissions.",
    );
  }
  return core.getIDToken(RISK_OIDC_AUDIENCE);
}

/**
 * Builds the error for a non-2xx answer from the problem document's `detail`
 * alone. The raw body is never quoted: it is not ours to print.
 */
async function requestError(
  response: Response,
  label: string,
): Promise<RiskRequestError> {
  let problem: z.infer<typeof ErrorBodySchema> = {};
  try {
    const parsed = ErrorBodySchema.safeParse(await response.json());
    if (parsed.success) problem = parsed.data;
  } catch {
    // Not JSON; the status alone describes the failure.
  }
  return new RiskRequestError(
    response.status,
    problem.code,
    `PR risk ${label} failed with status ${response.status}${
      problem.detail ? `: ${problem.detail}` : ""
    }`,
  );
}

async function post(
  path: string,
  label: string,
  body: unknown,
  timeoutMs: number,
  options: RiskClientOptions,
): Promise<unknown> {
  const request: RiskFetch = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}${path}`;
  const payload = JSON.stringify(body);
  return retryWithBackoff(
    async () => {
      const oidcToken = await options.getOidcToken?.();
      let response: Response;
      try {
        response = await request(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            ...(oidcToken ? { [RISK_OIDC_HEADER]: oidcToken } : {}),
          },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new RiskRequestError(
          undefined,
          undefined,
          `PR risk ${label} request did not complete (${
            error instanceof Error ? error.name : "error"
          })`,
        );
      }
      if (!response.ok) throw await requestError(response, label);
      try {
        return await response.json();
      } catch {
        throw new RiskError(
          "invalid_response",
          `PR risk ${label} answer was not JSON`,
        );
      }
    },
    {
      maxAttempts: 3,
      ...options.retry,
      shouldRetry: (error) =>
        error instanceof RiskRequestError &&
        (error.status === undefined || RETRYABLE_STATUSES.has(error.status)),
    },
  );
}

/** Names what failed to parse by path and code only, never by value. */
function parseAnswer<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  body: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.code}`)
    .join(", ");
  throw new RiskError(
    "invalid_response",
    `PR risk ${label} answer was not understood (${issues})`,
  );
}

/**
 * Asks Factory what to do with this pull request. A run Factory does not
 * trust to ask is a skip, not a failure: the same workflow file runs on
 * branches where that is expected.
 */
export async function beginRisk(
  request: RiskBeginRequest,
  options: RiskClientOptions,
): Promise<RiskBeginResponse> {
  let body: unknown;
  try {
    body = await post(
      RISK_BEGIN_PATH,
      "begin",
      request,
      BEGIN_TIMEOUT_MS,
      options,
    );
  } catch (error) {
    if (
      error instanceof RiskRequestError &&
      error.status === 403 &&
      error.code === RISK_WORKFLOW_NOT_TRUSTED
    ) {
      return { action: "skip", reason: RISK_WORKFLOW_NOT_TRUSTED };
    }
    throw error;
  }
  return parseAnswer(RiskBeginResponseSchema, body, "begin");
}

/** Hands the judged head and what came of it to Factory, which publishes. */
export async function settleRisk(
  request: RiskSettleRequest,
  options: RiskClientOptions,
): Promise<RiskSettleResponse> {
  return parseAnswer(
    RiskSettleResponseSchema,
    await post(RISK_SETTLE_PATH, "settle", request, SETTLE_TIMEOUT_MS, options),
    "settle",
  );
}
