import { describe, expect, it } from "bun:test";
import { prepareMcpTools } from "../../src/mcp/install-mcp-server";
import { createMockContext } from "../mockContext";
import { DroidRunType } from "../../src/run-type";

describe("prepareMcpTools", () => {
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
});
