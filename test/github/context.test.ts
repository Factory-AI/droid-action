import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as github from "@actions/github";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { parseGitHubContext } from "../../src/github/context";
import { shouldTriggerTag } from "../../src/tag";
import { extractCommandFromContext } from "../../src/github/utils/command-parser";

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
    ["omitted", undefined, false],
    ["off", "false", false],
    ["on", "true", true],
  ] as const)(
    "with automatic code review %s",
    (_label, reviewInput, automaticReview) => {
      it.each([
        ["omitted", undefined, automaticReview],
        ["empty", "", automaticReview],
        ["explicit false", "false", false],
        ["explicit true", "true", true],
      ] as const)(
        "parses %s security input",
        (_label, securityInput, securityEnabled) => {
          if (reviewInput === undefined) {
            delete process.env.AUTOMATIC_REVIEW;
          } else {
            process.env.AUTOMATIC_REVIEW = reviewInput;
          }
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
    },
  );

  for (const relativePath of ["action.yml", "prepare/action.yml"]) {
    it.each([
      ["off", false],
      ["on", true],
    ] as const)(
      `inherits security from code review with the actual ${relativePath} defaults (code=%s)`,
      (_name, automaticReview) => {
        const action = parse(
          readFileSync(join(import.meta.dir, "../..", relativePath), "utf8"),
        );
        process.env.AUTOMATIC_REVIEW = String(automaticReview);
        process.env.AUTOMATIC_SECURITY_REVIEW =
          action.inputs.automatic_security_review.default ?? "";

        expect(parseGitHubContext().inputs.automaticSecurityReview).toBe(
          automaticReview,
        );
      },
    );
  }

  it.each([
    ["issues", false],
    ["pull requests", true],
  ] as const)(
    "keeps @droid mentions on %s out of automatic review",
    (_name, isPR) => {
      delete process.env.AUTOMATIC_REVIEW;
      delete process.env.AUTOMATIC_SECURITY_REVIEW;
      github.context.eventName = "issue_comment";
      const comment = {
        id: 888,
        body: "@droid",
        user: { login: "human-reviewer" },
      };
      github.context.payload = {
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        issue: { number: 7, ...(isPR ? { pull_request: {} } : {}) },
        comment,
      };

      const context = parseGitHubContext();
      expect(context.inputs.automaticReview).toBe(false);
      expect(context.inputs.automaticSecurityReview).toBe(false);
      expect(shouldTriggerTag(context)).toBe(true);
      expect(extractCommandFromContext(context)?.command).toBe("default");

      comment.body = "No mention here";
      expect(shouldTriggerTag(parseGitHubContext())).toBe(false);
    },
  );
});
