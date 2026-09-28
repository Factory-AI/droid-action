import { afterEach, describe, expect, it } from "bun:test";
import {
  applyModelPolicyFallback,
  fetchModelPolicy,
  isModelAllowedByPolicy,
  isModelPolicyError,
} from "../src/utils/model-policy";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.FACTORY_API_KEY;

function mockFetch(handler: () => Promise<Response> | Response) {
  globalThis.fetch = Object.assign(async () => handler(), {
    preconnect: () => {},
  }) as unknown as typeof fetch;
}

function managedSettingsResponse(modelPolicy: unknown): Response {
  return new Response(
    JSON.stringify({ success: true, settings: { modelPolicy } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env.FACTORY_API_KEY;
  } else {
    process.env.FACTORY_API_KEY = originalApiKey;
  }
});

describe("isModelPolicyError", () => {
  it("matches the model policy 403 message with a straight apostrophe", () => {
    expect(
      isModelPolicyError(
        `403 {"detail":"This model is not available due to your organization's security settings."}`,
      ),
    ).toBe(true);
  });

  it("matches the model policy 403 message with a curly apostrophe", () => {
    expect(
      isModelPolicyError(
        "This model is not available due to your organization’s security settings.",
      ),
    ).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isModelPolicyError("500 Internal Server Error")).toBe(false);
    expect(isModelPolicyError(undefined)).toBe(false);
    expect(isModelPolicyError("")).toBe(false);
  });
});

describe("isModelAllowedByPolicy", () => {
  it("allows any model when there is no policy", () => {
    expect(isModelAllowedByPolicy("gpt-5.2", null)).toBe(true);
    expect(isModelAllowedByPolicy("gpt-5.2", undefined)).toBe(true);
  });

  it("denies models on the block list", () => {
    expect(
      isModelAllowedByPolicy("gpt-5.2", { blockedModelIds: ["gpt-5.2"] }),
    ).toBe(false);
  });

  it("allows everything when allowAllFactoryModels is true", () => {
    expect(
      isModelAllowedByPolicy("gpt-5.2", {
        allowAllFactoryModels: true,
        allowedModelIds: ["claude-opus-5"],
      }),
    ).toBe(true);
  });

  it("enforces a non-empty allow list", () => {
    const policy = { allowedModelIds: ["claude-opus-5", "kimi-k3"] };
    expect(isModelAllowedByPolicy("claude-opus-5", policy)).toBe(true);
    expect(isModelAllowedByPolicy("gpt-5.2", policy)).toBe(false);
  });

  it("treats an empty allow list as unrestricted", () => {
    expect(isModelAllowedByPolicy("gpt-5.2", { allowedModelIds: [] })).toBe(
      true,
    );
  });
});

describe("fetchModelPolicy", () => {
  it("parses the model policy from managed settings", async () => {
    mockFetch(() =>
      managedSettingsResponse({
        allowedModelIds: ["claude-opus-5"],
        allowAllFactoryModels: false,
      }),
    );

    const policy = await fetchModelPolicy("fk-test");
    expect(policy).toEqual({
      allowedModelIds: ["claude-opus-5"],
      blockedModelIds: undefined,
      allowAllFactoryModels: false,
    });
  });

  it("returns null when the org has no model policy", async () => {
    mockFetch(() =>
      Response.json({ success: true, settings: { ideAutoConnect: true } }),
    );

    expect(await fetchModelPolicy("fk-test")).toBeNull();
  });

  it("returns null on non-OK responses", async () => {
    mockFetch(() => new Response("nope", { status: 401 }));

    expect(await fetchModelPolicy("fk-test")).toBeNull();
  });

  it("returns null on malformed payloads", async () => {
    mockFetch(() => new Response("not json", { status: 200 }));

    expect(await fetchModelPolicy("fk-test")).toBeNull();
  });

  it("returns null on network errors", async () => {
    mockFetch(() => {
      throw new Error("connection refused");
    });

    expect(await fetchModelPolicy("fk-test")).toBeNull();
  });
});

describe("applyModelPolicyFallback", () => {
  const options = { flowLabel: "code review", modelInputName: "review_model" };

  it("keeps the model when it is allowed by the policy", async () => {
    process.env.FACTORY_API_KEY = "fk-test";
    mockFetch(() => managedSettingsResponse({ allowedModelIds: ["gpt-5.2"] }));

    const result = await applyModelPolicyFallback(
      { model: "gpt-5.2", reasoningEffort: "high" },
      options,
    );
    expect(result).toEqual({ model: "gpt-5.2", reasoningEffort: "high" });
  });

  it("drops the model and returns a note when the policy disallows it", async () => {
    process.env.FACTORY_API_KEY = "fk-test";
    mockFetch(() =>
      managedSettingsResponse({ allowedModelIds: ["claude-opus-5"] }),
    );

    const result = await applyModelPolicyFallback(
      { model: "gpt-5.2", reasoningEffort: "high" },
      options,
    );
    expect(result.model).toBeUndefined();
    expect(result.reasoningEffort).toBeUndefined();
    expect(result.fallbackNote).toContain("`gpt-5.2`");
    expect(result.fallbackNote).toContain("`review_model`");
  });

  it("keeps the model when the policy lookup fails", async () => {
    process.env.FACTORY_API_KEY = "fk-test";
    mockFetch(() => {
      throw new Error("connection refused");
    });

    const result = await applyModelPolicyFallback(
      { model: "gpt-5.2", reasoningEffort: "high" },
      options,
    );
    expect(result).toEqual({ model: "gpt-5.2", reasoningEffort: "high" });
  });

  it("skips the check when there is no API key", async () => {
    delete process.env.FACTORY_API_KEY;
    let fetchCalled = false;
    mockFetch(() => {
      fetchCalled = true;
      return managedSettingsResponse({ allowedModelIds: ["claude-opus-5"] });
    });

    const result = await applyModelPolicyFallback(
      { model: "gpt-5.2" },
      options,
    );
    expect(result.model).toBe("gpt-5.2");
    expect(fetchCalled).toBe(false);
  });

  it("passes through when no model was requested", async () => {
    process.env.FACTORY_API_KEY = "fk-test";
    let fetchCalled = false;
    mockFetch(() => {
      fetchCalled = true;
      return managedSettingsResponse({ allowedModelIds: ["claude-opus-5"] });
    });

    const result = await applyModelPolicyFallback({}, options);
    expect(result.model).toBeUndefined();
    expect(fetchCalled).toBe(false);
  });
});
