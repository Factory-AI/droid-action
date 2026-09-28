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
 * Matches Factory model tier aliases such as `openai-latest-balanced`.
 * The review presets default to these, so an unrecognized alias usually
 * means the installed CLI predates alias support rather than a bad input.
 */
export function isModelTierAlias(modelId: string): boolean {
  return /^[a-z0-9]+-latest-(premium|balanced|fast)$/.test(modelId);
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

  if (model && isModelTierAlias(model)) {
    return (
      `The installed Droid CLI does not support the model tier alias \`${model}\` ` +
      "yet, so Droid retried with your organization's default model. No " +
      "workflow change is needed; this resolves once the action installs a " +
      "CLI version with tier alias support. If you set " +
      "`path_to_droid_executable`, update that CLI."
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
