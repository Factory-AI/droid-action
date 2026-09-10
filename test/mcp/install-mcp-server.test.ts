import { afterEach, describe, expect, it } from "bun:test";
import { prepareMcpTools } from "../../src/mcp/install-mcp-server";
import { createMockContext } from "../mockContext";
import { DroidRunType } from "../../src/run-type";

describe("prepareMcpTools", () => {
  const originalPrCommentKind = process.env.DROID_PR_COMMENT_KIND;

  afterEach(() => {
    if (originalPrCommentKind === undefined) {
      delete process.env.DROID_PR_COMMENT_KIND;
    } else {
      process.env.DROID_PR_COMMENT_KIND = originalPrCommentKind;
    }
  });

  it("passes the run type to the comment server", async () => {
    const config = JSON.parse(
      await prepareMcpTools({
        githubToken: "token",
        owner: "factory",
        repo: "droid",
        droidCommentId: "123",
        runType: DroidRunType.Review,
        allowedTools: ["github_comment___update_droid_comment"],
        mode: "tag",
        context: createMockContext({ isPR: true }),
      }),
    );

    expect(config.mcpServers.github_comment.env.DROID_EXEC_RUN_TYPE).toBe(
      DroidRunType.Review,
    );
  });

  it("passes the run type to inline comment servers", async () => {
    const config = JSON.parse(
      await prepareMcpTools({
        githubToken: "token",
        owner: "factory",
        repo: "droid",
        droidCommentId: "123",
        runType: DroidRunType.SecurityReview,
        allowedTools: [
          "github_inline_comment___create_inline_comment",
          "github_pr___submit_review",
        ],
        mode: "tag",
        context: createMockContext({ isPR: true }),
      }),
    );

    expect(
      config.mcpServers.github_inline_comment.env.DROID_EXEC_RUN_TYPE,
    ).toBe(DroidRunType.SecurityReview);
    expect(config.mcpServers.github_pr.env.DROID_EXEC_RUN_TYPE).toBe(
      DroidRunType.SecurityReview,
    );
  });

  it("passes the actual tracking comment kind to the comment server", async () => {
    process.env.DROID_PR_COMMENT_KIND = "issue-comment";

    const config = JSON.parse(
      await prepareMcpTools({
        githubToken: "token",
        owner: "factory",
        repo: "droid",
        droidCommentId: "123",
        runType: DroidRunType.SecurityReview,
        allowedTools: ["github_comment___update_droid_comment"],
        mode: "tag",
        context: createMockContext({
          isPR: true,
          eventName: "pull_request_review_comment",
        }),
      }),
    );

    expect(config.mcpServers.github_comment.env.DROID_PR_COMMENT_KIND).toBe(
      "issue-comment",
    );
  });

  it("omits the run type from the comment server when unresolved", async () => {
    const config = JSON.parse(
      await prepareMcpTools({
        githubToken: "token",
        owner: "factory",
        repo: "droid",
        droidCommentId: "123",
        runType: null,
        allowedTools: ["github_comment___update_droid_comment"],
        mode: "tag",
        context: createMockContext({ isPR: true }),
      }),
    );

    expect(config.mcpServers.github_comment.env).not.toHaveProperty(
      "DROID_EXEC_RUN_TYPE",
    );
  });
});
