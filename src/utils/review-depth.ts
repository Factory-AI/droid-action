export enum ReviewDepth {
  Shallow = "shallow",
  Deep = "deep",
}

const SHALLOW_DEFAULTS = {
  model: "kimi-k2-0711",
  reasoningEffort: undefined as string | undefined,
};

const DEEP_DEFAULTS = {
  model: "gpt-5.2",
  reasoningEffort: "high" as string | undefined,
};

export const REVIEW_DEPTH_PRESETS: Record<
  ReviewDepth,
  { model: string; reasoningEffort: string | undefined }
> = {
  [ReviewDepth.Shallow]: SHALLOW_DEFAULTS,
  [ReviewDepth.Deep]: DEEP_DEFAULTS,
};

/**
 * Resolve the effective review model and reasoning effort based on depth.
 * Explicit overrides (review_model, reasoning_effort) take priority over depth presets.
 */
export function resolveReviewConfig(options?: {
  reviewModel?: string;
  reasoningEffort?: string;
  reviewDepth?: string;
}): { model: string; reasoningEffort: string | undefined } {
  const depth = (options?.reviewDepth || ReviewDepth.Deep) as ReviewDepth;
  const defaults =
    REVIEW_DEPTH_PRESETS[depth] ?? REVIEW_DEPTH_PRESETS[ReviewDepth.Shallow];

  return {
    model: options?.reviewModel || defaults.model,
    reasoningEffort: options?.reasoningEffort || defaults.reasoningEffort,
  };
}
