import { parseDocument } from "yaml";
import { z } from "zod";
import { retryWithBackoff } from "../../utils/retry";

const list = z.array(z.string().min(1).max(500)).max(200);
const sections = z.array(
  z.enum([
    "verdict",
    "findings",
    "changes",
    "details",
    "diagram",
    "risk",
    "effort",
  ]),
);
const checks = z.array(z.enum(["title", "description", "linked_issue"]));
const configSchema = z
  .object({
    review_depth: z.enum(["deep", "shallow"]).default("deep"),
    review_summary: z
      .enum(["comment", "description", "off"])
      .default("comment"),
    review_summary_sections: sections.default([
      "verdict",
      "findings",
      "changes",
      "details",
    ]),
    review_badges: z.enum(["image", "emoji", "text"]).default("text"),
    review_reactions: z.boolean().default(true),
    review_check_run: z.boolean().default(true),
    fail_on_severity: z.enum(["", "P0", "P1", "P2"]).default(""),
    review_incremental: z.boolean().default(true),
    review_auto_resolve: z.boolean().default(true),
    review_max_auto_runs: z.number().int().min(0).max(10000).default(0),
    show_dropped_findings: z.boolean().default(false),
    include_agent_prompts: z.boolean().default(true),
    fix_mode: z.enum(["commit", "pr", "off"]).default("commit"),
    review_diagram: z.enum(["auto", "off"]).default("auto"),
    review_severity_threshold: z.enum(["P0", "P1", "P2"]).default("P2"),
    review_ignore_paths: list.default([
      "**/*.lock",
      "**/*.lockb",
      "**/package-lock.json",
      "**/pnpm-lock.yaml",
      "**/go.sum",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/*.generated.*",
      "**/generated/**",
    ]),
    review_auto_triggers: list.default([
      "opened",
      "reopened",
      "synchronize",
      "ready_for_review",
    ]),
    review_drafts: z.boolean().default(false),
    review_effort: z.boolean().default(false),
    review_category_chips: z.boolean().default(false),
    review_suggest_reviewers: z.boolean().default(false),
    review_pre_merge_checks: checks.default([]),
    automatic_review: z.boolean().default(false),
    automatic_security_review: z.boolean().optional(),
    security_severity_threshold: z
      .enum(["critical", "high", "medium", "low"])
      .default("medium"),
    security_block_on_critical: z.boolean().default(true),
    security_block_on_high: z.boolean().default(false),
  })
  .strict();

export type ReviewUxConfig = Omit<
  z.infer<typeof configSchema>,
  "automatic_security_review"
> & {
  automatic_security_review: boolean;
};
export type ReviewConfigInputs = Record<string, string | undefined>;
export const REVIEW_CONFIG_PATH = ".factory/review.yaml";
export const MAX_REVIEW_CONFIG_BYTES = 64 * 1024;
export const REVIEW_CONFIG_KEYS = Object.keys(configSchema.shape);

export class ReviewConfigError extends Error {
  constructor(message: string) {
    super(`Invalid ${REVIEW_CONFIG_PATH}: ${message}`);
    this.name = "ReviewConfigError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) result[key] = entry;
  return result;
}

const aliases: Record<string, string> = {
  depth: "review_depth",
  severity_threshold: "review_severity_threshold",
  ignore_paths: "review_ignore_paths",
  summary_sections: "review_summary_sections",
  badges: "review_badges",
  incremental: "review_incremental",
  auto_resolve: "review_auto_resolve",
  max_auto_runs: "review_max_auto_runs",
};

function normalizeFileConfig(value: unknown): Record<string, unknown> {
  const source = record(value);
  if (!source) throw new ReviewConfigError("expected a YAML mapping");
  const normalized: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(source)) {
    if (key === "auto_review") {
      const automatic = record(entry);
      if (
        !automatic ||
        Object.keys(automatic).some(
          (name) =>
            !["enabled", "security", "triggers", "drafts"].includes(name),
        )
      ) {
        throw new ReviewConfigError(
          "auto_review accepts enabled, security, triggers, and drafts",
        );
      }
      for (const [name, target] of Object.entries({
        enabled: "automatic_review",
        security: "automatic_security_review",
        triggers: "review_auto_triggers",
        drafts: "review_drafts",
      })) {
        if (automatic[name] !== undefined) {
          if (source[target] !== undefined)
            throw new ReviewConfigError(`duplicate setting ${target}`);
          normalized[target] = automatic[name];
        }
      }
      continue;
    }
    const target = Object.hasOwn(aliases, key) ? aliases[key]! : key;
    if (
      (key !== target && source[target] !== undefined) ||
      Object.hasOwn(normalized, target)
    ) {
      throw new ReviewConfigError(`duplicate setting ${target}`);
    }
    normalized[target] = entry;
  }
  return normalized;
}

function invalidConfig(error: z.ZodError): ReviewConfigError {
  return new ReviewConfigError(
    error.issues
      .map((issue) => {
        // Zod messages can include enum values and unknown keys from the file.
        const key = issue.path[0];
        const setting =
          typeof key === "string" && REVIEW_CONFIG_KEYS.includes(key)
            ? key
            : "root";
        return `${setting}: ${issue.code === "unrecognized_keys" ? "unknown configuration setting" : "invalid value"}`;
      })
      .join("; "),
  );
}

/** The caller supplies content fetched from the base commit, never the checkout. */
export function parseReviewConfigYaml(raw: string): Record<string, unknown> {
  if (Buffer.byteLength(raw, "utf8") > MAX_REVIEW_CONFIG_BYTES)
    throw new ReviewConfigError("file exceeds 64 KiB");
  try {
    const document = parseDocument(raw, { uniqueKeys: true });
    if (document.errors.length)
      throw new ReviewConfigError("configuration is not valid YAML");
    const value: unknown = document.toJS({ maxAliasCount: 20 });
    const config = normalizeFileConfig(value ?? {});
    const parsed = configSchema.partial().safeParse(config);
    if (!parsed.success) throw invalidConfig(parsed.error);
    return config;
  } catch (error) {
    if (error instanceof ReviewConfigError) throw error;
    // Parser errors can quote source values. Never leak raw config or secrets.
    throw new ReviewConfigError("configuration is not valid YAML");
  }
}

const booleanKeys = new Set([
  "review_reactions",
  "review_check_run",
  "review_incremental",
  "review_auto_resolve",
  "show_dropped_findings",
  "include_agent_prompts",
  "review_drafts",
  "review_effort",
  "review_category_chips",
  "review_suggest_reviewers",
  "automatic_review",
  "automatic_security_review",
  "security_block_on_critical",
  "security_block_on_high",
]);
const listKeys = new Set([
  "review_summary_sections",
  "review_ignore_paths",
  "review_auto_triggers",
  "review_pre_merge_checks",
]);

function inputValue(key: string, raw: string): unknown {
  if (key === "review_depth" && raw !== "deep" && raw !== "shallow") {
    console.warn("Unknown review_depth; falling back to deep.");
    return "deep";
  }
  if (booleanKeys.has(key)) {
    if (raw !== "true" && raw !== "false")
      throw new ReviewConfigError(`${key} must be true or false`);
    return raw === "true";
  }
  if (key === "review_max_auto_runs") {
    if (!/^\d+$/.test(raw))
      throw new ReviewConfigError(`${key} must be a nonnegative integer`);
    return Number(raw);
  }
  if (listKeys.has(key)) {
    if (raw === "[]" || raw === "off") return [];
    return raw
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (key === "fail_on_severity" && raw === "off") return "";
  return raw;
}

/** Precedence: built-in defaults < base-branch file < nonempty action inputs. */
export function resolveReviewUxConfig(
  options: {
    fileConfig?: Record<string, unknown>;
    inputs?: ReviewConfigInputs;
  } = {},
): ReviewUxConfig {
  const overrides: Record<string, unknown> = {};
  for (const key of REVIEW_CONFIG_KEYS) {
    const raw = options.inputs?.[key]?.trim();
    if (raw) overrides[key] = inputValue(key, raw);
  }
  const parsed = configSchema.safeParse({
    ...options.fileConfig,
    ...overrides,
  });
  if (!parsed.success) throw invalidConfig(parsed.error);
  return {
    ...parsed.data,
    automatic_security_review:
      parsed.data.automatic_security_review ?? parsed.data.automatic_review,
  };
}

export function reviewInputsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ReviewConfigInputs {
  return Object.fromEntries(
    REVIEW_CONFIG_KEYS.map((key) => [key, env[key.toUpperCase()]]),
  );
}

export function reviewConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ReviewUxConfig {
  if (env.REVIEW_CONFIG_JSON) {
    let bound: unknown;
    try {
      bound = JSON.parse(env.REVIEW_CONFIG_JSON);
    } catch {
      throw new ReviewConfigError("invalid immutable configuration output");
    }
    const config = record(bound);
    if (!config)
      throw new ReviewConfigError("invalid immutable configuration output");
    return resolveReviewUxConfig({ fileConfig: config });
  }
  return resolveReviewUxConfig({ inputs: reviewInputsFromEnvironment(env) });
}

export function reviewConfigEnvironment(
  config: ReviewUxConfig,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key.toUpperCase(),
      Array.isArray(value)
        ? value.length
          ? value.join(",")
          : "[]"
        : String(value),
    ]),
  );
}

export function shouldIgnoreReviewPath(
  filePath: string,
  config: Pick<ReviewUxConfig, "review_ignore_paths">,
): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return config.review_ignore_paths.some((pattern) =>
    new Bun.Glob(pattern).match(normalized),
  );
}

export function automaticReviewSkipReason(options: {
  config: ReviewUxConfig;
  draft: boolean;
  eventAction?: string;
  manual: boolean;
}): string | null {
  if (options.manual) return null;
  if (options.draft && !options.config.review_drafts)
    return "draft PR. Comment @droid review to run anyway.";
  if (
    options.eventAction &&
    !options.config.review_auto_triggers.includes(options.eventAction)
  )
    return `automatic trigger ${options.eventAction} is disabled`;
  return null;
}

export type ReviewConfigBaseClient = {
  rest: {
    pulls: {
      get(params: {
        owner: string;
        repo: string;
        pull_number: number;
      }): Promise<{ data: unknown }>;
    };
    repos: {
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }): Promise<{ data: unknown }>;
    };
  };
};

function status(error: unknown): unknown {
  return error && typeof error === "object" && "status" in error
    ? error.status
    : undefined;
}

/** Fetches a fresh PR base SHA and pins the config read to that immutable SHA. */
export async function loadReviewUxConfigFromBase(options: {
  client: ReviewConfigBaseClient;
  owner: string;
  repo: string;
  prNumber: number;
  inputs?: ReviewConfigInputs;
  onBaseSha?: (sha: string) => void;
}): Promise<ReviewUxConfig> {
  const { client, owner, repo, prNumber } = options;
  const request = <T>(operation: () => Promise<T>) =>
    retryWithBackoff(operation, {
      initialDelayMs: 200,
      maxDelayMs: 1000,
      shouldRetry: (error) => status(error) !== 404 && status(error) !== 403,
    });
  const response = await request(() =>
    client.rest.pulls.get({ owner, repo, pull_number: prNumber }),
  );
  const pr = record(response.data);
  const base = record(pr?.base);
  if (typeof base?.sha !== "string" || !/^[a-f\d]{40,64}$/i.test(base.sha)) {
    throw new ReviewConfigError(
      "could not determine the immutable base commit; refusing to read head-branch configuration",
    );
  }
  const baseSha = base.sha;
  options.onBaseSha?.(baseSha);
  let fileConfig: Record<string, unknown> = {};
  try {
    const response = await request(() =>
      client.rest.repos.getContent({
        owner,
        repo,
        path: REVIEW_CONFIG_PATH,
        ref: baseSha,
      }),
    );
    const data = record(response.data);
    if (
      !data ||
      data.type !== "file" ||
      data.encoding !== "base64" ||
      typeof data.content !== "string"
    ) {
      throw new ReviewConfigError(
        "expected a regular UTF-8 configuration file",
      );
    }
    if (typeof data.size === "number" && data.size > MAX_REVIEW_CONFIG_BYTES)
      throw new ReviewConfigError("file exceeds 64 KiB");
    fileConfig = parseReviewConfigYaml(
      Buffer.from(data.content, "base64").toString("utf8"),
    );
  } catch (error) {
    if (status(error) !== 404) throw error;
  }
  return resolveReviewUxConfig({ fileConfig, inputs: options.inputs });
}
