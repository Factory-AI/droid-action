import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as github from "@actions/github";
import { parseGitHubContext } from "../../src/github/context";
import { shouldTriggerTag } from "../../src/tag";

describe("automatic review input parsing", () => {
  const originalContext = {
    eventName: github.context.eventName,
    payload: github.context.payload,
  };
  const originalEnvironment = {
    AUTOMATIC_REVIEW: process.env.AUTOMATIC_REVIEW,
    AUTOMATIC_SECURITY_REVIEW: process.env.AUTOMATIC_SECURITY_REVIEW,
  };

  beforeEach(() => {
    github.context.eventName = "pull_request";
    github.context.payload = {
      repository: {
        name: "test-repo",
        owner: { login: "test-owner" },
      },
      pull_request: { number: 7, body: "" },
    };
  });

  afterEach(() => {
    Object.assign(github.context, originalContext);
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  describe.each([
    ["off", false],
    ["on", true],
  ] as const)("with automatic code review %s", (_label, automaticReview) => {
    it.each([
      ["omitted", undefined, false],
      ["empty", "", false],
      ["explicit false", "false", false],
      ["explicit true", "true", true],
    ] as const)(
      "parses %s security input",
      (_label, securityInput, securityEnabled) => {
        process.env.AUTOMATIC_REVIEW = String(automaticReview);
        if (securityInput === undefined) {
          delete process.env.AUTOMATIC_SECURITY_REVIEW;
        } else {
          process.env.AUTOMATIC_SECURITY_REVIEW = securityInput;
        }

        const context = parseGitHubContext();

        expect(context.inputs.automaticReview).toBe(automaticReview);
        expect(context.inputs.automaticSecurityReview).toBe(securityEnabled);
        expect(shouldTriggerTag(context)).toBe(
          automaticReview || securityEnabled,
        );
      },
    );
  });
});
