export const RISK_PLAN_ENDPOINT = "/api/internal/pr-risk/plan";
export const RISK_PUBLISH_ENDPOINT = "/api/internal/pr-risk/publish";

/** How the run names itself to the backend. */
export const RISK_RUNNER = "droid-action";

const DEFAULT_BASE_URL = "https://api.factory.ai";
const RETRY_DELAY_MS = 2_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type RiskApi = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * A failed backend call. The message carries the route and the status only:
 * a response body can hold a judge skill or an HTML error page.
 */
export class RiskApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RiskApiError";
  }
}

export function riskApiFromEnv(
  env: Record<string, string | undefined>,
): RiskApi {
  const apiKey = env.FACTORY_API_KEY?.trim();
  if (!apiKey)
    throw new RiskApiError("A Factory API key is required for risk assessment");
  const raw = env.FACTORY_API_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RiskApiError("risk_api_base_url is not a URL");
  }
  // The key travels in a header, so a cleartext host is refused.
  if (url.protocol !== "https:")
    throw new RiskApiError("risk_api_base_url must use https");
  return { baseUrl: url.origin, apiKey };
}

/**
 * Who is asking. Only what the run can attest to about itself; the backend
 * reads everything about the pull request on its own.
 */
export function riskRunIdentity(
  env: Record<string, string | undefined>,
  extra: { droidCliVersion?: string } = {},
) {
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  return {
    runner: RISK_RUNNER,
    ...(env.GITHUB_EVENT_NAME ? { trigger: env.GITHUB_EVENT_NAME } : {}),
    ...(env.GITHUB_RUN_ID ? { runId: env.GITHUB_RUN_ID } : {}),
    ...(Number.isInteger(runAttempt) && runAttempt > 0 ? { runAttempt } : {}),
    ...(extra.droidCliVersion
      ? { droidCliVersion: extra.droidCliVersion }
      : {}),
    dryRun: env.RISK_DRY_RUN === "true",
  };
}

export type RiskRunIdentity = ReturnType<typeof riskRunIdentity>;

/**
 * POSTs one JSON body and returns the parsed JSON answer. A request that
 * never reached the backend or was answered 5xx is sent once more; a 4xx is
 * the backend's answer and is not repeated.
 */
export async function postRiskApi(
  api: RiskApi,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const fetchImpl: FetchLike =
    api.fetchImpl ?? ((url, init) => fetch(url, init));
  const attempt = async (): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${api.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${api.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RiskApiError(
        `${path} could not be reached (${error instanceof Error ? error.name : "unknown error"})`,
      );
    }
    if (!response.ok)
      throw new RiskApiError(
        `${path} answered ${response.status}`,
        response.status,
      );
    try {
      return await response.json();
    } catch {
      throw new RiskApiError(
        `${path} answered ${response.status} without JSON`,
        response.status,
      );
    }
  };
  try {
    return await attempt();
  } catch (error) {
    const retryable =
      error instanceof RiskApiError &&
      (error.status === undefined || error.status >= 500);
    if (!retryable) throw error;
    console.log(`${error.message}; retrying once`);
    const sleep =
      api.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    await sleep(RETRY_DELAY_MS);
    return attempt();
  }
}
