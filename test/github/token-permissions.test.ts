import { describe, expect, test } from "bun:test";
import {
  appTokenPermissionsFor,
  parseAppTokenPermissions,
} from "../../src/github/token-permissions";
import {
  createMockAutomationContext,
  mockIssueCommentContext,
  mockPullRequestCommentContext,
  mockPullRequestOpenedContext,
} from "../mockContext";
import type { ParsedGitHubContext } from "../../src/github/context";
import type {
  IssueCommentEvent,
  PullRequestOpenedEvent,
} from "@octokit/webhooks-types";

function withComment(
  context: ParsedGitHubContext,
  body: string,
): ParsedGitHubContext {
  const payload = context.payload as IssueCommentEvent;
  return {
    ...context,
    payload: { ...payload, comment: { ...payload.comment, body } },
  };
}

function withPullRequestBody(
  context: ParsedGitHubContext,
  body: string,
): ParsedGitHubContext {
  const payload = context.payload as PullRequestOpenedEvent;
  return {
    ...context,
    payload: { ...payload, pull_request: { ...payload.pull_request, body } },
  };
}

describe("appTokenPermissionsFor", () => {
  test("reviews on a pull request get contents read and pull request write", () => {
    expect(appTokenPermissionsFor(mockPullRequestCommentContext)).toEqual({
      contents: "read",
      pull_requests: "write",
    });
    expect(
      appTokenPermissionsFor({
        ...mockPullRequestOpenedContext,
        inputs: {
          ...mockPullRequestOpenedContext.inputs,
          automaticReview: true,
        },
      }),
    ).toEqual({ contents: "read", pull_requests: "write" });
  });

  test("a full security scan on a pull request can push its report branch", () => {
    expect(
      appTokenPermissionsFor(
        withComment(mockPullRequestCommentContext, "@droid security --full"),
      ),
    ).toEqual({ contents: "write", pull_requests: "write" });
  });

  test("automatic reviews stay read-only even when the PR body asks for a full scan", () => {
    const fullScanBody = withPullRequestBody(
      mockPullRequestOpenedContext,
      "@droid security --full",
    );
    for (const flag of ["automaticReview", "automaticSecurityReview"]) {
      expect(
        appTokenPermissionsFor({
          ...fullScanBody,
          inputs: { ...fullScanBody.inputs, [flag]: true },
        }),
      ).toEqual({ contents: "read", pull_requests: "write" });
    }
    expect(appTokenPermissionsFor(fullScanBody)).toEqual({
      contents: "write",
      pull_requests: "write",
    });
  });

  test("an issue gets issue write and no pull request access", () => {
    expect(appTokenPermissionsFor(mockIssueCommentContext)).toEqual({
      contents: "read",
      issues: "write",
    });
  });

  test("a full security scan from an issue can push and open its pull request", () => {
    expect(
      appTokenPermissionsFor(
        withComment(mockIssueCommentContext, "@droid security --full"),
      ),
    ).toEqual({ contents: "write", issues: "write", pull_requests: "write" });
  });

  test("CI Steward can read workflow runs and push fixes", () => {
    expect(
      appTokenPermissionsFor(
        createMockAutomationContext({
          eventName: "workflow_run",
          inputs: { ciSteward: true },
        }),
      ),
    ).toEqual({ actions: "read", contents: "write", pull_requests: "write" });
  });

  test("automation events that never trigger Droid only read contents", () => {
    expect(
      appTokenPermissionsFor(
        createMockAutomationContext({ eventName: "workflow_run" }),
      ),
    ).toEqual({ contents: "read" });
    expect(
      appTokenPermissionsFor(
        createMockAutomationContext({
          eventName: "schedule",
          inputs: { ciSteward: true },
        }),
      ),
    ).toEqual({ contents: "read" });
  });
});

describe("parseAppTokenPermissions", () => {
  test("keeps the full app token when unset", () => {
    expect(parseAppTokenPermissions(undefined)).toBeUndefined();
    expect(parseAppTokenPermissions("  ")).toBeUndefined();
  });

  test("reads a permission set", () => {
    expect(
      parseAppTokenPermissions('{"contents":"read","pull_requests":"write"}'),
    ).toEqual({ contents: "read", pull_requests: "write" });
  });

  test("rejects a permission the exchange does not narrow to", () => {
    expect(() =>
      parseAppTokenPermissions('{"contents":"read","workflows":"write"}'),
    ).toThrow("APP_TOKEN_PERMISSIONS");
  });

  test("rejects an unknown access level", () => {
    expect(() => parseAppTokenPermissions('{"contents":"admin"}')).toThrow(
      "APP_TOKEN_PERMISSIONS",
    );
  });

  test("rejects a value that is not a JSON object", () => {
    expect(() => parseAppTokenPermissions("contents:read")).toThrow(
      "APP_TOKEN_PERMISSIONS",
    );
    expect(() => parseAppTokenPermissions('["contents"]')).toThrow(
      "APP_TOKEN_PERMISSIONS",
    );
  });
});
