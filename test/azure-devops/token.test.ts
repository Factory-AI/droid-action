import { describe, expect, it } from "bun:test";
import {
  MissingAzureDevopsTokenError,
  UnexpandedAzureDevopsTokenError,
  setupAzureDevopsAuth,
  withoutAzureDevopsTokens,
} from "../../src/azure-devops/token";

describe("setupAzureDevopsAuth", () => {
  it("uses System.AccessToken as a bearer token by default", () => {
    expect(setupAzureDevopsAuth({ SYSTEM_ACCESSTOKEN: "abc" })).toEqual({
      kind: "bearer",
      token: "abc",
    });
  });

  it("prefers a real AZURE_DEVOPS_PAT over the job token", () => {
    expect(
      setupAzureDevopsAuth({
        SYSTEM_ACCESSTOKEN: "abc",
        AZURE_DEVOPS_PAT: "pat",
      }),
    ).toEqual({ kind: "pat", token: "pat" });
  });

  it("ignores an unexpanded AZURE_DEVOPS_PAT macro", () => {
    expect(
      setupAzureDevopsAuth({
        SYSTEM_ACCESSTOKEN: "abc",
        AZURE_DEVOPS_PAT: "$(AZURE_DEVOPS_PAT)",
      }),
    ).toEqual({ kind: "bearer", token: "abc" });
  });

  it("rejects an unexpanded System.AccessToken macro", () => {
    expect(() =>
      setupAzureDevopsAuth({ SYSTEM_ACCESSTOKEN: "$(System.AccesToken)" }),
    ).toThrow(UnexpandedAzureDevopsTokenError);
  });

  it("explains how to map the token when none is present", () => {
    expect(() =>
      setupAzureDevopsAuth({ AZURE_DEVOPS_PAT: "$(AZURE_DEVOPS_PAT)" }),
    ).toThrow(MissingAzureDevopsTokenError);
    expect(() => setupAzureDevopsAuth({})).toThrow(
      "SYSTEM_ACCESSTOKEN: $(System.AccessToken)",
    );
  });
});

describe("withoutAzureDevopsTokens", () => {
  it("drops every credential variable and keeps the rest", () => {
    expect(
      withoutAzureDevopsTokens({
        SYSTEM_ACCESSTOKEN: "a",
        AZURE_DEVOPS_PAT: "b",
        AZURE_DEVOPS_EXT_PAT: "c",
        FACTORY_API_KEY: "k",
      }),
    ).toEqual({ FACTORY_API_KEY: "k" });
  });
});
