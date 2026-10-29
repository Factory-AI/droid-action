import { afterEach, describe, expect, it, mock } from "bun:test";
import { createNotePipelineBridge } from "../../gitlab/note-pipeline-bridge";
import { GitlabClient } from "../../src/gitlab/api/client";
import {
  json,
  notFound,
  startFakeServer,
  type FakeServer,
} from "../bitbucket/fake-server";

let server: FakeServer | undefined;
afterEach(() => server?.stop());

function setup(
  options: {
    command?: string;
    role?: number;
    fork?: boolean;
    noteAuthor?: number;
  } = {},
) {
  server = startFakeServer((request, url) => {
    if (url.pathname.endsWith("/notes/20"))
      return json({
        id: 20,
        body: options.command ?? "@droid review --full",
        author: { id: options.noteAuthor ?? 5 },
      });
    if (url.pathname.endsWith("/merge_requests/7"))
      return json({
        iid: 7,
        state: "opened",
        source_project_id: options.fork ? 99 : 42,
        target_project_id: 42,
        source_branch: "feature",
        diff_refs: { head_sha: "a".repeat(40) },
      });
    if (url.pathname.endsWith("/members/all/5"))
      return json({ access_level: options.role ?? 40 });
    if (url.pathname.endsWith("/user")) return json({ id: 1 });
    if (request.method === "POST" && url.pathname.endsWith("/notes"))
      return json({ id: 21 });
    return notFound();
  });
  const trigger = mock(
    async (_input: { ref: string; mrIid: number; noteId: number }) => {},
  );
  const handler = createNotePipelineBridge({
    client: new GitlabClient("test-token", `${server.url}/api/v4`),
    projectId: 42,
    webhookSecret: "webhook-test-secret",
    trigger,
  });
  const request = (
    extra: { secret?: string; projectId?: number; note?: string } = {},
  ) =>
    handler(
      new Request("https://bridge.example.test/gitlab", {
        method: "POST",
        headers: {
          "x-gitlab-token": extra.secret ?? "webhook-test-secret",
          "x-gitlab-event": "Note Hook",
        },
        body: JSON.stringify({
          object_kind: "note",
          project: { id: extra.projectId ?? 42 },
          merge_request: { iid: 7 },
          object_attributes: {
            id: 20,
            noteable_type: "MergeRequest",
            action: "create",
            note: extra.note ?? "@droid fix",
            author_id: 999,
          },
        }),
      }),
    );
  return { request, trigger, requests: server.requests };
}

describe("authenticated GitLab note-to-pipeline bridge", () => {
  it("rejects a bad webhook secret before any API lookup", async () => {
    const t = setup();
    expect((await t.request({ secret: "wrong" })).status).toBe(401);
    expect(t.requests).toHaveLength(0);
    expect(t.trigger).not.toHaveBeenCalled();
  });

  it("only dispatches configured-project MRs", async () => {
    const t = setup();
    await t.request({ projectId: 99 });
    expect(t.requests).toHaveLength(0);
    expect(t.trigger).not.toHaveBeenCalled();
  });

  it("fetches the real note and actual author instead of trusting webhook text", async () => {
    const t = setup({ command: "`@droid fix` is an example" });
    expect((await t.request()).status).toBe(200);
    expect(t.trigger).not.toHaveBeenCalled();
  });

  it("requires Developer write permission from live GitLab membership", async () => {
    const t = setup({ role: 20 });
    expect((await t.request()).status).toBe(403);
    expect(t.trigger).not.toHaveBeenCalled();
    expect(
      t.requests.some((request) => request.path.endsWith("/members/all/5")),
    ).toBe(true);
  });

  it("starts a same-project source-branch pipeline with only addressing hints", async () => {
    const t = setup();
    expect((await t.request()).status).toBe(200);
    expect(t.trigger).toHaveBeenCalledWith({
      ref: "feature",
      mrIid: 7,
      noteId: 20,
    });
  });

  it("does not trigger a duplicate pipeline on webhook retries", async () => {
    const t = setup();
    await t.request();
    await t.request();
    expect(t.trigger).toHaveBeenCalledTimes(1);
  });

  it("does not loop on the bot's own notes", async () => {
    const t = setup({ noteAuthor: 1 });
    await t.request();
    expect(t.trigger).not.toHaveBeenCalled();
  });

  it("explicitly refuses fork refs without handing target secrets to a fork pipeline", async () => {
    const t = setup({ fork: true });
    await t.request();
    expect(t.trigger).not.toHaveBeenCalled();
    const reply = t.requests.find((request) => request.method === "POST");
    expect(reply?.body.body).toContain(
      "does not run fork code with target-project secrets",
    );
  });
});
