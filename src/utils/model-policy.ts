import * as core from "@actions/core";

/**
 * Subset of the Factory org model policy returned by
 * GET /api/organization/managed-settings. Unknown fields are ignored.
 */
export type ModelPolicy = {
  allowedModelIds?: string[];
  blockedModelIds?: string[];
  allowAllFactoryModels?: boolean;
};

const DEFAULT_FACTORY_API_BASE_URL = "https://app.factory.ai";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Matches the 403 error returned by the Factory API when a request uses a
 * model that the organization's model policy does not allow.
 */
const MODEL_POLICY_ERROR_PATTERN =
  /not available due to your organization['’]s security settings/i;

export function isModelPolicyError(text: string | undefined | null): boolean {
  if (!text) {
    return false;
  }
  return MODEL_POLICY_ERROR_PATTERN.test(text);
}

/**
 * Fetch the organization's model policy using the Factory API key.
 * Returns null when the org has no policy or when the policy cannot be
 * determined (network error, unexpected payload, etc). Callers must treat
 * null as "no restriction" so a policy lookup failure never breaks a run.
 */
export async function fetchModelPolicy(
  factoryApiKey: string,
  options?: { baseUrl?: string; timeoutMs?: number },
): Promise<ModelPolicy | null> {
  const baseUrl =
    options?.baseUrl ||
    process.env.FACTORY_API_BASE_URL ||
    DEFAULT_FACTORY_API_BASE_URL;
  const timeoutMs = options?.timeoutMs ?? FETCH_TIMEOUT_MS;

  try {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/api/organization/managed-settings`,
      {
        headers: {
          Authorization: `Bearer ${factoryApiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    if (!response.ok) {
      console.warn(
        `Model policy lookup returned HTTP ${response.status}; proceeding without a policy check`,
      );
      return null;
    }

    const payload: unknown = await response.json();
    if (
      typeof payload !== "object" ||
      payload === null ||
      (payload as { success?: unknown }).success !== true
    ) {
      return null;
    }

    const settings = (payload as { settings?: unknown }).settings;
    if (typeof settings !== "object" || settings === null) {
      return null;
    }

    const rawPolicy = (settings as { modelPolicy?: unknown }).modelPolicy;
    if (typeof rawPolicy !== "object" || rawPolicy === null) {
      return null;
    }

    const policy = rawPolicy as Record<string, unknown>;
    const toStringArray = (value: unknown): string[] | undefined =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : undefined;

    return {
      allowedModelIds: toStringArray(policy.allowedModelIds),
      blockedModelIds: toStringArray(policy.blockedModelIds),
      allowAllFactoryModels:
        typeof policy.allowAllFactoryModels === "boolean"
          ? policy.allowAllFactoryModels
          : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `Model policy lookup failed (${message}); proceeding without a policy check`,
    );
    return null;
  }
}

/**
 * Conservative client-side mirror of the server-side model policy check.
 * Only returns false when the policy definitively disallows the model;
 * any ambiguity resolves to allowed (the server remains the enforcer).
 */
export function isModelAllowedByPolicy(
  modelId: string,
  policy: ModelPolicy | null | undefined,
): boolean {
  if (!policy) {
    return true;
  }
  if (policy.blockedModelIds?.includes(modelId)) {
    return false;
  }
  if (policy.allowAllFactoryModels === true) {
    return true;
  }
  if (policy.allowedModelIds && policy.allowedModelIds.length > 0) {
    return policy.allowedModelIds.includes(modelId);
  }
  return true;
}

export type PolicyCheckedModelConfig = {
  model?: string;
  reasoningEffort?: string;
  fallbackNote?: string;
};

/**
 * Pre-flight check of a resolved model against the org's model policy.
 * When the model is disallowed, drops the model (and reasoning effort) so
 * `droid exec` falls back to the organization's default model, and returns
 * a note describing the fallback for surfacing in the tracking comment.
 */
export async function applyModelPolicyFallback(
  config: { model?: string; reasoningEffort?: string },
  options: { flowLabel: string; modelInputName: string },
): Promise<PolicyCheckedModelConfig> {
  const { model, reasoningEffort } = config;
  const factoryApiKey = process.env.FACTORY_API_KEY;

  if (!model || !factoryApiKey) {
    return { model, reasoningEffort };
  }

  const policy = await fetchModelPolicy(factoryApiKey);
  if (isModelAllowedByPolicy(model, policy)) {
    return { model, reasoningEffort };
  }

  const fallbackNote =
    `The ${options.flowLabel} model \`${model}\` is not allowed by your ` +
    `organization's model policy, so Droid used your organization's default ` +
    `model instead. Set the \`${options.modelInputName}\` input to an ` +
    `approved model to control which model is used.`;

  core.warning(
    `Model "${model}" is not allowed by the organization's model policy; ` +
      `omitting --model so droid exec uses the organization's default model`,
  );

  return { fallbackNote };
}
