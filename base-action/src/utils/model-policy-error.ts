/**
 * Matches the 403 errors returned by the Factory API when a request uses a
 * model that the organization's model policy does not allow, including the
 * explicit opt-in variant ("This model requires explicit organization
 * opt-in by an admin."), and the stderr message droid exec prints when it
 * rejects a --model value (e.g. a resolved tier alias) against the policy
 * before starting.
 */
const MODEL_POLICY_ERROR_PATTERNS = [
  /not available due to your organization['’]s security settings/i,
  /requires explicit organization opt-in/i,
  /Model blocked by organization policy/i,
];

export function isModelPolicyError(text: string | undefined | null): boolean {
  if (!text) {
    return false;
  }
  return MODEL_POLICY_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Matches the fast client-side failure droid exec prints to stderr when the
 * --model value is not a recognized model id.
 */
export function isInvalidModelError(text: string | undefined | null): boolean {
  if (!text) {
    return false;
  }
  return /Invalid model:/i.test(text);
}

/**
 * An invalid --model value makes droid exec dump the full list of available
 * models (twice, with one line per dump that is hundreds of characters
 * wide). Condense that output down to the meaningful lines so it can be
 * embedded in a PR comment without sideways scrolling.
 */
export function condenseInvalidModelError(text: string): string {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^Available built-in models:$/i.test(trimmed)) continue;
    if (/^No custom models configured/i.test(trimmed)) continue;
    // Drop raw model-list dumps (long comma-separated lines)
    if (trimmed.split(", ").length >= 5) continue;
    if (kept[kept.length - 1] === trimmed) continue;
    kept.push(trimmed);
  }
  const condensed = kept.join("\n");
  return condensed || text;
}

const MODEL_OVERRIDES_DOCS_URL =
  "https://github.com/Factory-AI/droid-action#advanced-model-overrides";

/**
 * Concrete stand-ins for each model tier alias, used when the installed
 * Droid CLI predates alias support and rejects the alias as an invalid
 * model. Each entry is a GA model that such CLIs already know and that sits
 * in the alias's candidate list in the CLI, so the review keeps the same
 * tier (and supports `--reasoning-effort high`) instead of dropping to the
 * org default.
 */
const LEGACY_TIER_ALIAS_MODELS: Record<string, string> = {
  "openai-latest-premium": "gpt-6-astra",
  "openai-latest-balanced": "gpt-5.6-sol",
  "openai-latest-fast": "gpt-5.6-luna",
  "anthropic-latest-premium": "claude-opus-5-5",
  "anthropic-latest-balanced": "claude-opus-5-5",
  "anthropic-latest-fast": "claude-haiku-4-5-20251001",
  "oss-latest-premium": "kimi-k3",
  "oss-latest-balanced": "glm-5.3",
  "oss-latest-fast": "glm-5.3-flash",
};

export function getLegacyTierAliasModel(
  modelId: string | undefined,
): string | undefined {
  return modelId && Object.hasOwn(LEGACY_TIER_ALIAS_MODELS, modelId)
    ? LEGACY_TIER_ALIAS_MODELS[modelId]
    : undefined;
}

/** Replace the value of every `--model` flag, keeping all other args. */
export function replaceModelArg(args: string[], model: string): string[] {
  return args.map((arg, i) => {
    if (args[i - 1] === "--model") return model;
    if (arg.startsWith("--model=")) return `--model=${model}`;
    return arg;
  });
}

/** Return the value of the last `--model` flag in an argv array. */
export function getModelArg(args: string[]): string | undefined {
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--model") {
      model = args[i + 1];
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    }
  }
  return model?.replace(/^["']|["']$/g, "") || undefined;
}

/**
 * Build the tracking-comment note shown after droid exec rejected the
 * requested model and the run was retried with the org's default model.
 */
export function describeModelFallback(options: {
  policyBlocked: boolean;
  model: string | undefined;
}): string {
  const { policyBlocked, model } = options;
  const modelLabel = model ? `model \`${model}\`` : "requested model";

  if (policyBlocked) {
    return (
      `The ${modelLabel} is not allowed by your organization's model policy, ` +
      "so Droid retried with your organization's default model. Remove the " +
      "model input (e.g. `review_model`) to use the recommended default, or " +
      `set it to a [model tier alias](${MODEL_OVERRIDES_DOCS_URL}) approved ` +
      "by your organization."
    );
  }

  return (
    `The ${modelLabel} is not a recognized model id, so Droid retried with ` +
    "your organization's default model. Set the model input (e.g. " +
    "`review_model`) to a supported model id or a " +
    `[model tier alias](${MODEL_OVERRIDES_DOCS_URL}), or remove it to use ` +
    "the recommended default."
  );
}

/**
 * Remove `--model <value>` and `--reasoning-effort <value>` (including
 * `--flag=value` forms) from an argv array so droid exec falls back to the
 * organization's default model.
 */
export function stripModelArgs(args: string[]): string[] {
  const stripped: string[] = [];
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "--model" || arg === "--reasoning-effort") {
      skipNext = true;
      continue;
    }
    if (arg.startsWith("--model=") || arg.startsWith("--reasoning-effort=")) {
      continue;
    }
    stripped.push(arg);
  }

  return stripped;
}
