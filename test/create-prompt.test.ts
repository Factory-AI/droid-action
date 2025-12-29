#!/usr/bin/env bun

import { describe, test, expect } from "bun:test";
import {
  buildAllowedToolsString,
  buildDisallowedToolsString,
  prepareContext,
} from "../src/create-prompt";
import type { ParsedGitHubContext } from "../src/github/context";

describe("prepareContext", () => {
  const baseContext = {
    runId: "1",
    repository: {
      owner: "owner",
      repo: "repo",
      full_name: "owner/repo",
    },
    actor: "user",
    inputs: {
      triggerPhrase: "@droid",
      assigneeTrigger: "",
      labelTrigger: "",
      useStickyComment: false,
      allowedBots: "",
      allowedNonWriteUsers: "",
      trackProgress: false,
      automaticReview: false,
      automaticSecurityReview: false,
    },
  } as const;

  test("handles pull request review comments", () => {
    const context: ParsedGitHubContext = {
      ...baseContext,
      eventName: "pull_request_review_comment",
      eventAction: "created",
      entityNumber: 7,
      isPR: true,
      payload: {
        comment: {
          id: 88,
          body: "@droid review",
          user: { login: "alice" },
        },
      } as any,
    };

    const prepared = prepareContext(context, "55", "main", undefined);

    expect(prepared.droidCommentId).toBe("55");
    if (prepared.eventData.eventName !== "pull_request_review_comment") {
      throw new Error("Unexpected event type");
    }
    expect(prepared.eventData.prNumber).toBe("7");
  });

  test("requires base and droid branches for issue comments", () => {
    const context: ParsedGitHubContext = {
      ...baseContext,
      eventName: "issue_comment",
      eventAction: "created",
      entityNumber: 9,
      isPR: false,
      payload: {
        comment: {
          id: 99,
          body: "@droid help",
          user: { login: "bob" },
        },
        issue: { number: 9 },
      } as any,
    };

    expect(() => prepareContext(context, "12")).toThrow();

    const prepared = prepareContext(context, "12", "main", "droid/issue-9");
    if (prepared.eventData.eventName !== "issue_comment") {
      throw new Error("Unexpected event type for issue comment");
    }
    expect(prepared.eventData.baseBranch).toBe("main");
    expect(prepared.eventData.droidBranch).toBe("droid/issue-9");
  });
});

describe("buildAllowedToolsString", () => {
  const baseTools = [
    "Execute",
    "Edit",
    "Create",
    "Read",
    "Glob",
    "Grep",
    "LS",
    "github_comment___update_droid_comment",
  ];

  test("returns baseline set", () => {
    const result = buildAllowedToolsString();
    baseTools.forEach((tool) => expect(result).toContain(tool));
  });

  test("includes custom additions", () => {
    const result = buildAllowedToolsString(["custom_tool"]);
    expect(result).toContain("custom_tool");
  });

  test("adds CI tools when requested", () => {
    const result = buildAllowedToolsString([], true);
    expect(result).toContain("github_ci___get_ci_status");
  });
});

describe("buildDisallowedToolsString", () => {
  test("defaults to web search and fetch", () => {
    const result = buildDisallowedToolsString();
    expect(result).toContain("WebSearch");
    expect(result).toContain("FetchUrl");
  });

  test("removes tools that are explicitly allowed", () => {
    const result = buildDisallowedToolsString(undefined, ["WebSearch"]);
    expect(result).not.toContain("WebSearch");
  });

  test("appends custom disallowed entries", () => {
    const result = buildDisallowedToolsString(["DangerousTool"]);
    expect(result).toContain("DangerousTool");
  });
});
