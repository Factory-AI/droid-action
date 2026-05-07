const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set(
  [
    "apiKey",
    "api_key",
    "token",
    "secret",
    "password",
    "authorization",
    "auth",
    "credential",
    "clientSecret",
    "accessToken",
    "refreshToken",
    "FACTORY_API_KEY",
    "CUSTOM_MODEL_API_KEY",
    "PROVIDER_API_KEY",
    "GITHUB_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ].map((key) => key.toLowerCase()),
);

const SENSITIVE_TEXT_KEY =
  "(?:apiKey|api_key|token|secret|password|authorization|auth|credential|clientSecret|accessToken|refreshToken|FACTORY_API_KEY|CUSTOM_MODEL_API_KEY|PROVIDER_API_KEY|GITHUB_TOKEN|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

function looksHighEntropy(value: string): boolean {
  if (value.length < 40) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  return new Set(value).size >= 8;
}

export function redactText(input: string): string {
  let output = input;

  output = output.replace(/\b(?:ghs|ghp|gho|ghr)_[A-Za-z0-9_]+\b/g, REDACTED);
  output = output.replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, REDACTED);
  output = output.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED);
  output = output.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED);

  output = output.replace(
    new RegExp("\\b(" + SENSITIVE_TEXT_KEY + "\\s*=\\s*)([^\\s\"';]+)", "gi"),
    `$1${REDACTED}`,
  );
  output = output.replace(
    new RegExp(`\\b(${SENSITIVE_TEXT_KEY}\\s*:\\s*)([^\\r\\n,}]+)`, "gi"),
    `$1${REDACTED}`,
  );

  output = output.replace(
    /(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{40,}(?![A-Za-z0-9_+/=-])/g,
    (match) => (looksHighEntropy(match) ? REDACTED : match),
  );

  return output;
}

export function redactJsonValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveKey(key)) return REDACTED;

  if (typeof value === "string") {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactJsonValue(entryValue, entryKey),
      ]),
    );
  }

  return value;
}

export function redactJsonText(input: string): string {
  try {
    return `${JSON.stringify(redactJsonValue(JSON.parse(input)), null, 2)}\n`;
  } catch {
    return redactText(input);
  }
}

export function redactJsonlText(input: string): string {
  const hasTrailingNewline = input.endsWith("\n");
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  if (hasTrailingNewline) lines.pop();

  const redacted = lines.map((line) => {
    if (line.trim() === "") return line;

    try {
      return JSON.stringify(redactJsonValue(JSON.parse(line)));
    } catch {
      return redactText(line);
    }
  });

  return `${redacted.join("\n")}${hasTrailingNewline ? "\n" : ""}`;
}

export function redactFileText(path: string, input: string): string {
  if (path.endsWith(".jsonl")) return redactJsonlText(input);
  if (path.endsWith(".json")) return redactJsonText(input);
  return redactText(input);
}
