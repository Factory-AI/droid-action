import { describe, expect, it } from "bun:test";
import { prepareMcpTools } from "../../src/mcp/install-mcp-server";
import { createMockContext } from "../mockContext";

describe("prepareMcpTools", () => {
  it("passes the PR validation source to the comment server", async () => {
    const config = JSON.parse(
      await prepareMcpTools({
        githubToken: "token",
        owner: "factory",
        repo: "droid",
        droidCommentId: "123",
        prValidationSource: "review",
        allowedTools: ["github_comment___update_droid_comment"],
        mode: "tag",
        context: createMockContext({ isPR: true }),
      }),
    );

    expect(
      config.mcpServers.github_comment.env.DROID_PR_VALIDATION_SOURCE,
    ).toBe("review");
  });
});
