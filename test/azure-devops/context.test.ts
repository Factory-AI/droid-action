import { describe, expect, it } from "bun:test";
import {
  parseAzureDevopsContext,
  reviewSkipReason,
} from "../../src/azure-devops/context";
import { SERVICES_ENV } from "./helpers";

describe("parseAzureDevopsContext", () => {
  it("parses a Services PR build", () => {
    const ctx = parseAzureDevopsContext({ ...SERVICES_ENV });
    expect(ctx.collectionUri).toBe("https://dev.azure.com/contoso");
    expect(ctx.hosting).toBe("services");
    expect(ctx.project).toEqual({
      id: "6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c",
      name: "Fabrikam Web",
    });
    expect(ctx.repository.webUrl).toBe(
      "https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app",
    );
    expect(ctx.pullRequest).toEqual({
      id: 17,
      sourceBranch: "refs/heads/feature",
      targetBranch: "refs/heads/main",
      sourceCommitId: null,
      isFork: false,
      webUrl:
        "https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/17",
    });
    expect(ctx.build.url).toBe(
      "https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=4521",
    );
    expect(ctx.build.jobUrl).toBe(
      "https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=4521&view=logs&j=12f1170f-54f2-53f3-20dd-22fc7dff55f9",
    );
    expect(ctx.user.name).toBe("Ada Lovelace");
    expect(reviewSkipReason(ctx)).toBeNull();
  });

  it("recognizes visualstudio.com as Services and a collection URL as Server", () => {
    expect(
      parseAzureDevopsContext({
        ...SERVICES_ENV,
        SYSTEM_COLLECTIONURI: "https://contoso.visualstudio.com/",
      }).hosting,
    ).toBe("services");
    const server = parseAzureDevopsContext({
      ...SERVICES_ENV,
      SYSTEM_COLLECTIONURI: "https://ado.contoso.local/tfs/DefaultCollection/",
    });
    expect(server.hosting).toBe("server");
    expect(server.build.url).toBe(
      "https://ado.contoso.local/tfs/DefaultCollection/Fabrikam%20Web/_build/results?buildId=4521",
    );
  });

  it("falls back to SYSTEM_TEAMFOUNDATIONCOLLECTIONURI", () => {
    const { SYSTEM_COLLECTIONURI: _, ...env } = SERVICES_ENV;
    const ctx = parseAzureDevopsContext({
      ...env,
      SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/other/",
    });
    expect(ctx.collectionUri).toBe("https://dev.azure.com/other");
  });

  it("treats unexpanded macros as unset", () => {
    const ctx = parseAzureDevopsContext({
      ...SERVICES_ENV,
      SYSTEM_PULLREQUEST_PULLREQUESTID: "$(System.PullRequest.PullRequestId)",
      REVIEW_DEPTH: "$(REVIEW_DEPTH)",
    });
    expect(ctx.pullRequest).toBeNull();
    expect(ctx.inputs.reviewDepth).toBe("deep");
  });

  it("reads inputs with their defaults", () => {
    const ctx = parseAzureDevopsContext({
      ...SERVICES_ENV,
      AUTOMATIC_SECURITY_REVIEW: "true",
      REVIEW_DEPTH: "shallow",
      INCLUDE_SUGGESTIONS: "false",
      SYSTEM_PULLREQUEST_ISFORK: "True",
    });
    expect(ctx.inputs.automaticReview).toBe(true);
    expect(ctx.inputs.automaticSecurityReview).toBe(true);
    expect(ctx.inputs.reviewDepth).toBe("shallow");
    expect(ctx.inputs.includeSuggestions).toBe(false);
    expect(ctx.inputs.securityBlockOnCritical).toBe(true);
    expect(ctx.pullRequest?.isFork).toBe(true);
  });

  it("names the missing variable outside a pipeline", () => {
    expect(() => parseAzureDevopsContext({})).toThrow(
      "SYSTEM_TEAMFOUNDATIONCOLLECTIONURI",
    );
    expect(() =>
      parseAzureDevopsContext({
        SYSTEM_COLLECTIONURI: "https://dev.azure.com/x",
      }),
    ).toThrow("SYSTEM_TEAMPROJECT");
  });
});

describe("reviewSkipReason", () => {
  it("skips non-PR builds", () => {
    expect(
      reviewSkipReason(
        parseAzureDevopsContext({ ...SERVICES_ENV, BUILD_REASON: "Manual" }),
      ),
    ).toBe("not-pull-request-build (Build.Reason=Manual)");
  });

  it("skips non Azure Repos providers", () => {
    expect(
      reviewSkipReason(
        parseAzureDevopsContext({
          ...SERVICES_ENV,
          BUILD_REPOSITORY_PROVIDER: "GitHub",
        }),
      ),
    ).toBe("unsupported-repository-provider (GitHub)");
  });

  it("skips fork pull requests", () => {
    expect(
      reviewSkipReason(
        parseAzureDevopsContext({
          ...SERVICES_ENV,
          SYSTEM_PULLREQUEST_ISFORK: "True",
        }),
      ),
    ).toBe("fork-pull-request");
  });

  it("skips when automatic review is off", () => {
    expect(
      reviewSkipReason(
        parseAzureDevopsContext({ ...SERVICES_ENV, AUTOMATIC_REVIEW: "false" }),
      ),
    ).toBe("automatic-review-disabled");
  });
});
