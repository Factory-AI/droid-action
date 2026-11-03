/**
 * Credential redaction for text that leaves the job: comments posted to GitHub
 * or GitLab, step logs and outputs, and debug artifacts. Model output can quote
 * anything a tool printed, so every publishing path runs it through here.
 */

export const REDACTED = "[REDACTED]";

// Shorter values would also match ordinary text, and none of the credentials
// this guards (GitHub tokens, Factory API keys, CI job tokens) are this short.
const MIN_SECRET_LENGTH = 8;

/** Variables that can hold a credential in a GitHub Actions review job. */
export const GITHUB_CREDENTIAL_ENV_NAMES = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OVERRIDE_GITHUB_TOKEN",
  "DEFAULT_WORKFLOW_TOKEN",
  "FACTORY_API_KEY",
  "APP_PRIVATE_KEY",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
] as const;

/** Variables that can hold a credential in a GitLab CI review job. */
export const GITLAB_CREDENTIAL_ENV_NAMES = [
  "GITLAB_TOKEN",
  "OVERRIDE_GITLAB_TOKEN",
  "FACTORY_API_KEY",
  "CI_JOB_TOKEN",
  "CI_REGISTRY_PASSWORD",
  "CI_DEPENDENCY_PROXY_PASSWORD",
] as const;

/** Variables that can hold a credential in a Bitbucket review job. */
export const BITBUCKET_CREDENTIAL_ENV_NAMES = [
  "DROID_BITBUCKET_TOKEN",
  "DROID_BITBUCKET_API_TOKEN",
  "BITBUCKET_STEP_OIDC_TOKEN",
  "FACTORY_API_KEY",
] as const;

/** Variables that can hold a credential in an Azure Pipelines review job. */
export const AZURE_DEVOPS_CREDENTIAL_ENV_NAMES = [
  "SYSTEM_ACCESSTOKEN",
  "AZURE_DEVOPS_PAT",
  "AZURE_DEVOPS_EXT_PAT",
  "FACTORY_API_KEY",
] as const;

export const CREDENTIAL_ENV_NAMES: readonly string[] = [
  ...new Set<string>([
    ...GITHUB_CREDENTIAL_ENV_NAMES,
    ...GITLAB_CREDENTIAL_ENV_NAMES,
    ...BITBUCKET_CREDENTIAL_ENV_NAMES,
    ...AZURE_DEVOPS_CREDENTIAL_ENV_NAMES,
  ]),
];

const GITHUB_TOKEN_LABEL = "[REDACTED_GITHUB_TOKEN]";

// A token starts at a value boundary, so identifiers that merely contain a
// prefix (`dfk-...`, `my.glpat-...`) are left alone. A JSON escape such as
// `\n` also ends a value: in session transcripts and stream-json output, a
// token at the start of a line comes right after the escape's letter.
const AFTER_JSON_ESCAPE = String.raw`(?<=\\[nrt])`;
const TOKEN_START = String.raw`(?:(?<![\w.$-])|${AFTER_JSON_ESCAPE})`;
const GITHUB_TOKEN_START = String.raw`(?:\b|${AFTER_JSON_ESCAPE})`;
const ASSIGNMENT_KEY = String.raw`(?:FACTORY_API_KEY|GITHUB_TOKEN|APP_PRIVATE_KEY|api[_-]?key|access[_-]?token|password|secret)`;
// Split encoded log lines only where the following value is also redacted.
// Other backslashes, including escaped backslash pairs, stay inside the secret.
const NEXT_CREDENTIAL_FIELD = String.raw`(?:authorization|${ASSIGNMENT_KEY})\s*[:=]`;
// A literal (even-backslash) continuation is still one secret. Consume its
// known field prefix and quoted value too, rather than stranding a token after
// the prefix's whitespace. These atoms never consume an actual line break.
const EMBEDDED_CREDENTIAL_PREFIX = String.raw`(?:authorization[^\S\r\n]*[:=][^\S\r\n]*(?:(?:bearer|basic)[^\S\r\n]+)?|${ASSIGNMENT_KEY}[^\S\r\n]*[:=][^\S\r\n]*)`;
const EMBEDDED_QUOTED_VALUE = String.raw`(?:"(?:\\[^\r\n]|[^"\\\r\n])*(?:\\(?=\r?$))?(?:"|(?=\r?$))|'(?:\\[^\r\n]|[^'\\\r\n])*(?:\\(?=\r?$))?(?:'|(?=\r?$)))`;
const BARE_CREDENTIAL_VALUE = String.raw`(?:\\(?!(?:r\\n|[nrt])(?=${NEXT_CREDENTIAL_FIELD}))[^\s,"';]?|${EMBEDDED_CREDENTIAL_PREFIX}(?:${EMBEDDED_QUOTED_VALUE})?|[^\\\s,"';])+`;
// Artifact collection maps UTF-8 bytes through latin1 without reserializing them.
const UTF8_LATIN1_HORIZONTAL_SPACE = String.raw`(?:\u00c2\u00a0|\u00e1\u009a\u0080|\u00e2\u0080[\u0080-\u008a\u00a8\u00a9\u00af]|\u00e2\u0081\u009f|\u00e3\u0080\u0080|\u00ef\u00bb\u00bf)`;
// Include native horizontal whitespace and its JSON and collected byte spellings.
const JSON_HORIZONTAL_SPACE = String.raw`(?:[^\S\r\n]|\\[tf]|\\u(?:000[9bc]|0020|00a0|1680|200[0-9a]|202[89f]|205f|3000|feff)|${UTF8_LATIN1_HORIZONTAL_SPACE})`;
const JSON_LINE_BREAK = String.raw`\\(?:[rn]|u000[ad])`;
const JSON_SPACE = String.raw`(?:${JSON_HORIZONTAL_SPACE}|[\r\n]|${JSON_LINE_BREAK})`;
const JSON_QUOTED_DELIMITER = String.raw`\\(?:"|u0022)`;
const JSON_ESCAPED_BACKSLASH = String.raw`(?:\\{2}|\\u005[cC])`;
const JSON_VALUE_END = String.raw`(?="|${JSON_LINE_BREAK}|[\r\n]|(?![\s\S]))`;
// Only the backslash continuation may peek past a final malformed escape.
// The value's closing arm still requires that trailing byte to be consumed.
const JSON_BACKSLASH_END = String.raw`(?:${JSON_VALUE_END}|(?=\\(?:[\r\n]|(?![\s\S]))))`;
// These character classes exclude encoded backslashes, quotes and line breaks.
// Each decoded backslash then consumes exactly one character or a true boundary.
// Keep the alternatives disjoint, including malformed trailing escapes at EOF.
const JSON_VALUE_CHARACTER = String.raw`(?:\\(?!u(?:0022|005c|000[ad]))[^"\\rn\r\n]|[^"\\\r\n])`;
const JSON_QUOTED_VALUE = String.raw`(?:${JSON_ESCAPED_BACKSLASH}(?:${JSON_ESCAPED_BACKSLASH}|${JSON_QUOTED_DELIMITER}|${JSON_VALUE_CHARACTER}|${JSON_BACKSLASH_END})|${JSON_VALUE_CHARACTER})*(?:\\(?=[\r\n]|(?![\s\S])))?`;

const FACTORY_API_KEY_PATTERN = new RegExp(
  `${TOKEN_START}fk-[A-Za-z0-9_-]{20,}`,
  "g",
);

// Personal/project/group access, deploy, runner, CI job, pipeline trigger,
// feed, OAuth application, SCIM, incoming mail, agent, feature flag client and
// workspace tokens. Job tokens from before GitLab 17.x have no prefix and are
// caught by exact-value redaction instead.
const GITLAB_TOKEN_PATTERN = new RegExp(
  `${TOKEN_START}gl(?:pat|dt|rt|cbt|ptt|ft|oas|soat|imt|agent|ffct|wt)-[A-Za-z0-9_.=-]{20,}`,
  "g",
);

// A truncated key (no END line) is redacted through the end of the text.
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

const GITHUB_TOKEN_PATTERNS = [
  // Personal access tokens (classic): ghp_ + 36 chars
  String.raw`ghp_[A-Za-z0-9]{36}\b`,
  // OAuth tokens: gho_ + 36 chars
  String.raw`gho_[A-Za-z0-9]{36}\b`,
  // App installation tokens: ghs_ followed by 36+ chars. The newer stateless
  // format is ~520 chars and can include '.', '-' and '_', so the length must
  // stay open-ended (pattern recommended by GitHub).
  String.raw`ghs_[A-Za-z0-9._-]{36,}`,
  // User-to-server tokens issued to GitHub Apps: ghu_ + 36 chars
  String.raw`ghu_[A-Za-z0-9]{36}\b`,
  // Refresh tokens: ghr_ + 36 chars
  String.raw`ghr_[A-Za-z0-9]{36}\b`,
  // Fine-grained personal access tokens: github_pat_ (up to 255 chars)
  String.raw`github_pat_[A-Za-z0-9_]{11,221}\b`,
  // Any token in the form actions/checkout writes to git's http.extraheader:
  // base64 of `x-access-token:<token>`.
  String.raw`eC1hY2Nlc3MtdG9rZW46[A-Za-z0-9+/]+={0,2}`,
].map((pattern) => new RegExp(`${GITHUB_TOKEN_START}${pattern}`, "g"));

export function redactGitHubTokens(content: string): string {
  for (const pattern of GITHUB_TOKEN_PATTERNS) {
    content = content.replace(pattern, GITHUB_TOKEN_LABEL);
  }
  return content;
}

/** Redacts credentials recognizable by their format alone. */
export function redactCredentialPatterns(content: string): string {
  content = redactGitHubTokens(content);
  content = content.replace(
    FACTORY_API_KEY_PATTERN,
    "[REDACTED_FACTORY_API_KEY]",
  );
  content = content.replace(GITLAB_TOKEN_PATTERN, "[REDACTED_GITLAB_TOKEN]");
  content = content.replace(PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]");
  return content
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|sk-(?:ant-)?[A-Za-z0-9_-]{8,}|fk_[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})\b/g,
      REDACTED,
    )
    .replace(
      new RegExp(
        String.raw`((?:\b|${AFTER_JSON_ESCAPE})authorization${JSON_HORIZONTAL_SPACE}*[:=]${JSON_HORIZONTAL_SPACE}*(?:(?:bearer|basic)${JSON_HORIZONTAL_SPACE}+)?)(${JSON_QUOTED_DELIMITER})((?:(?:bearer|basic)${JSON_HORIZONTAL_SPACE}+)?)(?:${JSON_QUOTED_VALUE})(${JSON_QUOTED_DELIMITER}|${JSON_VALUE_END})|((?:\b|${AFTER_JSON_ESCAPE})authorization[^\S\r\n]*[:=][^\S\r\n]*(?:(?:bearer|basic)[^\S\r\n]+)?)(?:(["'])((?:(?:bearer|basic)[^\S\r\n]+)?)(?:\\[^\r\n]|(?!\6)[^\\\r\n])*(?:\\(?=\r?$))?(\6|(?=\r?$))|(${BARE_CREDENTIAL_VALUE})(["']?))`,
        "gim",
      ),
      (
        _match,
        jsonPrefix: string | undefined,
        jsonOpening: string | undefined,
        jsonScheme: string | undefined,
        jsonClosing: string | undefined,
        prefix: string | undefined,
        opening: string | undefined,
        scheme: string | undefined,
        closing: string | undefined,
        _value: string | undefined,
        trailing: string | undefined,
      ) =>
        `${jsonPrefix ?? prefix}${jsonOpening ?? opening ?? ""}${jsonScheme ?? scheme ?? ""}${REDACTED}${jsonClosing ?? closing ?? trailing ?? ""}`,
    )
    .replace(
      new RegExp(
        String.raw`((?:\b|${AFTER_JSON_ESCAPE})${ASSIGNMENT_KEY}${JSON_SPACE}*[:=]${JSON_SPACE}*)(${JSON_QUOTED_DELIMITER})(?:${JSON_QUOTED_VALUE})(${JSON_QUOTED_DELIMITER}|${JSON_VALUE_END})|((?:\b|${AFTER_JSON_ESCAPE})${ASSIGNMENT_KEY}\s*[:=]\s*)(?:(["'])(?:\\[^\r\n]|(?!\5)[^\\\r\n])*(?:\\(?=\r?$))?(\5|(?=\r?$))|(${BARE_CREDENTIAL_VALUE})(["']?))`,
        "gim",
      ),
      (
        _match,
        jsonPrefix: string | undefined,
        jsonOpening: string | undefined,
        jsonClosing: string | undefined,
        prefix: string | undefined,
        opening: string | undefined,
        closing: string | undefined,
        _value: string | undefined,
        trailing: string | undefined,
      ) =>
        `${jsonPrefix ?? prefix}${jsonOpening ?? opening ?? ""}${REDACTED}${jsonClosing ?? closing ?? trailing ?? ""}`,
    )
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[REDACTED]@")
    .replace(
      /([?&](?:token|key|secret|password|signature|credential|access_token|api_key)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    );
}

/** Reads the named variables, longest value first so no secret is left partly redacted by a shorter one it contains. */
export function secretValuesFromEnv(
  names: readonly string[] = CREDENTIAL_ENV_NAMES,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const values = new Set<string>();
  for (const name of names) {
    const value = env[name]?.trim();
    if (value && value.length >= MIN_SECRET_LENGTH) {
      values.add(value);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Replaces each given secret, then every credential recognizable by format. */
export function redactSecrets(
  content: string,
  secrets: readonly string[],
): string {
  let result = content;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) {
      result = result.split(secret).join(REDACTED);
    }
  }
  return redactCredentialPatterns(result);
}

/** Redacts the credentials this process holds in its environment, and any recognizable by format. */
export function redactCredentials(
  content: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return redactSecrets(content, secretValuesFromEnv(CREDENTIAL_ENV_NAMES, env));
}

/** Applies {@link redactSecrets} to every string inside a JSON-like value. */
export function redactDeep(
  value: unknown,
  secrets: readonly string[],
): unknown {
  if (typeof value === "string") {
    return redactSecrets(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, secrets));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactDeep(item, secrets),
      ]),
    );
  }
  return value;
}
