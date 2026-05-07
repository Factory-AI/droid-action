import { describe, expect, it } from "bun:test";
import {
  redactJsonText,
  redactJsonlText,
  redactText,
} from "../../src/debug-artifacts/redact";

function fakeGitHubToken(prefix = "ghs"): string {
  return [prefix, "_", "a".repeat(36)].join("");
}

function fakeGitHubPat(): string {
  return ["github", "pat", "test", "fake", "token"].join("_");
}

function fakeBearerHeader(): string {
  return ["Bearer", ["test", "bearer", "token"].join("-")].join(" ");
}

describe("debug artifact redaction", () => {
  it("redacts apiKey recursively in JSON", () => {
    const redacted = redactJsonText(
      JSON.stringify({
        customModels: [{ apiKey: "custom-model-secret-test-value" }],
      }),
    );

    expect(redacted).not.toContain("custom-model-secret-test-value");
    expect(JSON.parse(redacted).customModels[0].apiKey).toBe("[REDACTED]");
  });

  it("redacts api_key recursively in JSON", () => {
    const redacted = redactJsonText(
      JSON.stringify({ nested: { api_key: "openai-secret-test-value" } }),
    );

    expect(redacted).not.toContain("openai-secret-test-value");
    expect(JSON.parse(redacted).nested.api_key).toBe("[REDACTED]");
  });

  it("redacts token/auth/secret/password keys case-insensitively", () => {
    const redacted = JSON.parse(
      redactJsonText(
        JSON.stringify({
          Token: "token-value",
          AUTH: "auth-value",
          Secret: "secret-value",
          password: "password-value",
        }),
      ),
    );

    expect(redacted.Token).toBe("[REDACTED]");
    expect(redacted.AUTH).toBe("[REDACTED]");
    expect(redacted.Secret).toBe("[REDACTED]");
    expect(redacted.password).toBe("[REDACTED]");
  });

  it("redacts GitHub tokens in MCP-shaped JSON", () => {
    const githubActionsToken = fakeGitHubToken();
    const redacted = redactJsonText(
      JSON.stringify({
        mcpServers: {
          github: {
            env: {
              GITHUB_TOKEN: githubActionsToken,
            },
          },
        },
      }),
    );

    expect(redacted).not.toContain(githubActionsToken);
    expect(JSON.parse(redacted).mcpServers.github.env.GITHUB_TOKEN).toBe(
      "[REDACTED]",
    );
  });

  it("redacts Bearer tokens in logs", () => {
    const bearerHeader = fakeBearerHeader();
    const bearerValue = bearerHeader.replace("Bearer ", "");
    const redacted = redactText(`Authorization: ${bearerHeader}\nnext line`);

    expect(redacted).not.toContain(bearerValue);
    expect(redacted).toContain("Authorization: [REDACTED]");
  });

  it("redacts env assignment strings", () => {
    const githubActionsToken = fakeGitHubToken();
    const redacted = redactText(
      `GITHUB_TOKEN=${githubActionsToken} --env TOKEN=secret-value`,
    );

    expect(redacted).not.toContain(githubActionsToken);
    expect(redacted).not.toContain("secret-value");
    expect(redacted).toContain("GITHUB_TOKEN=[REDACTED]");
    expect(redacted).toContain("TOKEN=[REDACTED]");
  });

  it("redacts high-entropy Base64-like values with symbol edges", () => {
    const token = `+${"Ab3/=".repeat(8)}Z9=`;
    const redacted = redactText(`payload ${token} done`);

    expect(redacted).not.toContain(token);
    expect(redacted).toContain("payload [REDACTED] done");
  });

  it("redacts JSONL line by line", () => {
    const githubPatToken = fakeGitHubPat();
    const bearerHeader = fakeBearerHeader();
    const bearerValue = bearerHeader.replace("Bearer ", "");
    const redacted = redactJsonlText(
      `${JSON.stringify({ token: githubPatToken })}\nnot json Authorization: ${bearerHeader}\n`,
    );

    expect(redacted).not.toContain(githubPatToken);
    expect(redacted).not.toContain(bearerValue);
    expect(redacted.split("\n")[0]).toBe('{"token":"[REDACTED]"}');
  });

  it("falls back to text redaction for invalid JSON", () => {
    const githubActionsToken = fakeGitHubToken();
    const redacted = redactJsonText(
      `{ invalid json GITHUB_TOKEN=${githubActionsToken}`,
    );

    expect(redacted).not.toContain(githubActionsToken);
    expect(redacted).toContain("GITHUB_TOKEN=[REDACTED]");
  });
});
