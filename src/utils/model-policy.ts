import * as core from "@actions/core";

/**
 * Subset of the Factory org model policy returned by
 * GET /api/organization/managed-settings. Unknown fields are ignored.
 *
 * `customModelIds` are the org-managed BYOK custom model ids (from
 * `settings.customModels`), carried so a custom model can be recognized and
 * gated on `allowCustomModels` instead of the Factory-model allow list, which
 * is what the server does.
 */
export type ModelPolicy = {
  allowedModelIds?: string[];
  blockedModelIds?: string[];
  allowAllFactoryModels?: boolean;
  allowCustomModels?: boolean;
  customModelIds?: string[];
};

const DEFAULT_FACTORY_API_BASE_URL = "https://app.factory.ai";
const FETCH_TIMEOUT_MS = 10_000;
const CUSTOM_MODEL_PREFIX = "custom:";

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
 * Collect the ids a custom model can be addressed by. The CLI accepts the
 * canonical `custom:<name>-<index>` id, the same id without the `custom:`
 * prefix, and (legacy) the provider model name, so all three are kept. The
 * unprefixed forms can collide with Factory model ids (a BYOK proxy for
 * `gpt-5.2` has `model: "gpt-5.2"`), so {@link isModelAllowedByPolicy} only
 * uses them to admit a model, never to reject one.
 */
function collectCustomModelIds(customModels: unknown): string[] {
  if (!Array.isArray(customModels)) {
    return [];
  }
  const ids = new Set<string>();
  for (const entry of customModels) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { id, model } = entry as { id?: unknown; model?: unknown };
    if (typeof id === "string" && id) {
      ids.add(id);
      if (id.startsWith(CUSTOM_MODEL_PREFIX)) {
        ids.add(id.slice(CUSTOM_MODEL_PREFIX.length));
      }
    }
    if (typeof model === "string" && model) {
      ids.add(model);
      ids.add(`${CUSTOM_MODEL_PREFIX}${model}`);
    }
  }
  return [...ids];
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
      allowCustomModels:
        typeof policy.allowCustomModels === "boolean"
          ? policy.allowCustomModels
          : undefined,
      customModelIds: collectCustomModelIds(
        (settings as { customModels?: unknown }).customModels,
      ),
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
 * Matches Factory model tier aliases such as `openai-latest-balanced`. The
 * Droid CLI resolves them to a concrete model and enforces the org policy on
 * that model, which this action cannot know in advance.
 */
export function isModelTierAlias(modelId: string): boolean {
  return /^[a-z0-9]+-latest-(premium|balanced|fast)$/.test(modelId);
}

/**
 * Whether the id may name a BYOK custom model rather than a Factory model: an
 * explicit `custom:` id, or an id that matches one of the org-managed custom
 * models (the CLI also resolves unprefixed ids against them). Only the
 * `custom:` form is unambiguous; an unprefixed match may equally be a
 * Factory model that a BYOK entry proxies.
 */
export function isCustomModel(
  modelId: string,
  policy: ModelPolicy | null | undefined,
): boolean {
  return (
    modelId.startsWith(CUSTOM_MODEL_PREFIX) ||
    (policy?.customModelIds?.includes(modelId) ?? false)
  );
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
  if (!policy || isModelTierAlias(modelId)) {
    return true;
  }
  // Custom models are governed only by the custom-model toggle; the Factory
  // allow/block lists never name them, so checking them there would reject
  // every custom model in an org that uses an allow list.
  if (modelId.startsWith(CUSTOM_MODEL_PREFIX)) {
    return policy.allowCustomModels !== false;
  }
  if (isCustomModel(modelId, policy)) {
    // An unprefixed match may also be a Factory model (a BYOK proxy for
    // `gpt-5.2` has `model: "gpt-5.2"`). While custom models are enabled the
    // CLI will resolve it, so admit it; when they are disabled, fall through
    // and let the Factory lists decide so an allowed Factory model survives.
    if (policy.allowCustomModels !== false) {
      return true;
    }
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
    `model instead. Remove the \`${options.modelInputName}\` input to use ` +
    `the recommended default, or set it to a model tier alias approved ` +
    `by your organization.`;

  core.warning(
    `Model "${model}" is not allowed by the organization's model policy; ` +
      `omitting --model so droid exec uses the organization's default model`,
  );

  return { fallbackNote };
}
