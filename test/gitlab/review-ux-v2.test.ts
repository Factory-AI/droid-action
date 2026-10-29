import { afterEach, describe, expect, it } from "bun:test";
import { GitlabClient } from "../../src/gitlab/api/client";
import {
  json,
  startFakeServer,
  type FakeServer,
} from "../bitbucket/fake-server";

let server: FakeServer | undefined;
afterEach(() => server?.stop());
describe("GitLab review UX v2", () => {
  it("paginates beyond 100 notes so an old sticky summary remains discoverable", async () => {
    server = startFakeServer((_request, url) =>
      json(
        url.searchParams.get("page") === "2"
          ? [{ id: 101 }]
          : Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })),
      ),
    );
    const notes = await new GitlabClient(
      "test-token",
      `${server.url}/api/v4`,
    ).listNotes(42, 7);
    expect(notes).toHaveLength(101);
    expect(server.requests[1]?.path).toContain("page=2");
  });
});
