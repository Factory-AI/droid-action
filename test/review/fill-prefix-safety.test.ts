import { describe, expect, test } from "bun:test";
import { updateGeneratedDescription } from "../../src/core/review/fill";
import {
  handleUpdatePRDescription,
  type OctokitLike,
} from "../../src/mcp/github-pr-server";

describe("recoverable generated description ownership", () => {
  test.each([
    ["Notes\n\n```text\nexample", "Summary"],
    ["Notes\n\n<details>\nexample", "Summary"],
    ["Notes", "Summary\n\n```text\nexample"],
    ["Notes", "Summary\n\n<details>\nexample"],
  ])(
    "refuses hidden delimiters without publishing: %s",
    async (existing, generated) => {
      let updates = 0;
      const client = {
        rest: {
          pulls: {
            get: async () => ({
              data: { body: existing, head: { sha: "a".repeat(40) } },
            }),
            update: async () => {
              updates++;
            },
          },
        },
      } as unknown as OctokitLike;
      await expect(
        handleUpdatePRDescription({
          owner: "org",
          repo: "repo",
          prNumber: 12,
          body: generated,
          mode: "generated",
          octokit: client,
        }),
      ).rejects.toThrow("markers");
      expect(updates).toBe(0);
    },
  );
  test("valid generated Markdown stays idempotent and preserves author bytes", () => {
    const author =
      "Manual notes\r\n\r\n<details>\r\nAuthor example\r\n</details>\r\n";
    const generated =
      "Summary\n\n```text\nexample\n```\n\n<details>\nMore\n</details>";
    const first = updateGeneratedDescription(author, generated, "a".repeat(40));
    expect(first.startsWith(author)).toBe(true);
    expect(updateGeneratedDescription(first, generated, "a".repeat(40))).toBe(
      first,
    );
  });
});
