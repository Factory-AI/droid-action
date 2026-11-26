import * as core from "@actions/core";
import { z } from "zod";
import { retryWithBackoff, type RetryOptions } from "../../utils/retry";
import type { RiskCall, RiskStep } from "./droid-risk";
import {
  RISK_OIDC_AUDIENCE,
  RISK_UNKNOWN_ACTION,
  RISK_WORKFLOW_NOT_TRUSTED,
  RiskBeginResponseSchema,
  RiskError,
  RiskSettleResponseSchema,
  type RiskBeginRequest,
  type RiskBeginResponse,
  type RiskSettleRequest,
  type RiskSettleResponse,
} from "./types";

const RETRYABLE_STATUSES = new Set([502, 503, 504]);

const ErrorBodySchema = z.object({
  detail: z.string().optional(),
  code: z.string().optional(),
});

export type RiskClientOptions = {
  /** Sends one step; `droidRiskCall` runs `droid risk`, which holds the key. */
  call: RiskCall;
  /**
   * Mints the OIDC token that proves which workflow is asking. Resolving to
   * undefined sends the request without one, which Factory accepts only for
   * a dry run.
   */
  getOidcToken?: () => Promise<string | undefined>;
  retry?: RetryOptions;
};

/**
 * Returns `raw` when it is an https URL on factory.ai or one of its
 * subdomains, and throws otherwise. The judge session sends the API key to
 * this URL, and the URL comes from a workflow input a pull request can
 * change.
 */
export function assertFactoryApiBaseUrl(raw: string): string {
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    // Not echoed: it may not be a URL at all.
  }
  const host = url?.hostname;
  if (
    url?.protocol !== "https:" ||
    (host !== "factory.ai" && !host?.endsWith(".factory.ai"))
  ) {
    throw new RiskError(
      "untrusted_api_url",
      `Refusing to send the Factory API key to ${
        url ? url.origin : "a value that is not a URL"
      }: the Factory API URL must be https on factory.ai or a subdomain of it.`,
    );
  }
  return raw;
}

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
function requestError(
  status: number,
  body: unknown,
  step: RiskStep,
): RiskRequestError {
  const parsed = ErrorBodySchema.safeParse(body);
  const problem = parsed.success ? parsed.data : {};
  return new RiskRequestError(
    status,
    problem.code,
    `PR risk ${step} failed with status ${status}${
      problem.detail ? `: ${problem.detail}` : ""
    }`,
  );
}

async function post(
  step: RiskStep,
  request: unknown,
  options: RiskClientOptions,
): Promise<unknown> {
  return retryWithBackoff(
    async () => {
      const oidcToken = await options.getOidcToken?.();
      const answer = await options.call(step, {
        request,
        ...(oidcToken ? { oidcToken } : {}),
      });
      if ("error" in answer) {
        // The CLI's transport message is not quoted, as for any request
        // that got no answer.
        if (answer.error === "request_failed" || !("message" in answer)) {
          throw new RiskRequestError(
            undefined,
            undefined,
            `PR risk ${step} request did not complete`,
          );
        }
        throw new RiskError(
          answer.error === "untrusted_api_url"
            ? "untrusted_api_url"
            : "droid_risk_failed",
          answer.message,
        );
      }
      if (answer.status < 200 || answer.status > 299) {
        throw requestError(answer.status, answer.body, step);
      }
      return answer.body;
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
 * Whether Factory answered with a variant added after this version. Such an
 * answer is not a malformed one: the caller reads it as the answer that does
 * nothing, where a known variant with a bad field still fails.
 */
function namesUnknownVariant(
  schema: { discriminator: string; optionsMap: Map<z.Primitive, unknown> },
  body: unknown,
): boolean {
  const fields = z.record(z.unknown()).safeParse(body);
  if (!fields.success) return false;
  const tag = fields.data[schema.discriminator];
  return typeof tag === "string" && !schema.optionsMap.has(tag);
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
    body = await post("begin", request, options);
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
  if (namesUnknownVariant(RiskBeginResponseSchema, body)) {
    return { action: "skip", reason: RISK_UNKNOWN_ACTION };
  }
  return parseAnswer(RiskBeginResponseSchema, body, "begin");
}

/** Hands the judged head and what came of it to Factory, which publishes. */
export async function settleRisk(
  request: RiskSettleRequest,
  options: RiskClientOptions,
): Promise<RiskSettleResponse> {
  const body = await post("settle", request, options);
  if (namesUnknownVariant(RiskSettleResponseSchema, body)) {
    return { status: "unknown" };
  }
  return parseAnswer(RiskSettleResponseSchema, body, "settle");
}
