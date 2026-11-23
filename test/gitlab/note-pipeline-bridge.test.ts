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
    delegations?: unknown;
    sourceBranch?: string;
    liveProject?: number;
    liveIid?: number;
    state?: string;
    head?: string;
    expiresAt?: string;
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
        project_id: options.liveProject ?? 42,
        iid: options.liveIid ?? 7,
        state: options.state ?? "opened",
        source_project_id: options.fork ? 99 : 42,
        target_project_id: 42,
        source_branch: options.sourceBranch ?? "feature",
        diff_refs: { head_sha: options.head ?? "a".repeat(40) },
      });
    if (/\/members\/all\/\d+$/.test(url.pathname))
      return json({
        access_level: options.role ?? 40,
        expires_at: options.expiresAt,
      });
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
    pipelineDelegations:
      "delegations" in options
        ? options.delegations
        : [{ authorId: 5, sourceBranches: ["feature"] }],
    trigger,
  });
  const request = (
    extra: {
      secret?: string;
      projectId?: number;
      note?: string;
      authorId?: number;
      sourceBranch?: string;
    } = {},
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
          merge_request: {
            iid: 7,
            source_branch: extra.sourceBranch ?? "forged-payload-branch",
          },
          object_attributes: {
            id: 20,
            noteable_type: "MergeRequest",
            action: "create",
            note: extra.note ?? "@droid fix",
            author_id: extra.authorId ?? 999,
          },
        }),
      }),
    );
  return { request, trigger, requests: server.requests };
}

describe("authenticated GitLab note-to-pipeline bridge", () => {
  for (const [label, delegations] of [
    ["missing", undefined],
    ["null", null],
    ["empty", []],
    ["boolean bypass", true],
    [
      "raw JSON instead of parsed policy",
      '[{"authorId":5,"sourceBranches":["feature"]}]',
    ],
    ["zero user", [{ authorId: 0, sourceBranches: ["feature"] }]],
    ["negative user", [{ authorId: -5, sourceBranches: ["feature"] }]],
    ["fractional user", [{ authorId: 5.5, sourceBranches: ["feature"] }]],
    [
      "unsafe user",
      [{ authorId: Number.MAX_SAFE_INTEGER + 1, sourceBranches: ["feature"] }],
    ],
    ["string user", [{ authorId: "5", sourceBranches: ["feature"] }]],
    ["empty refs", [{ authorId: 5, sourceBranches: [] }]],
    ["blank ref", [{ authorId: 5, sourceBranches: [""] }]],
    ["padded ref", [{ authorId: 5, sourceBranches: ["feature "] }]],
    ["wildcard", [{ authorId: 5, sourceBranches: ["feature/*"] }]],
    ["character pattern", [{ authorId: 5, sourceBranches: ["[feature]"] }]],
    ["role grant", [{ authorId: 5, sourceBranches: ["feature"], role: 30 }]],
    [
      "project override",
      [{ authorId: 5, sourceBranches: ["feature"], projectId: 99 }],
    ],
  ]) {
    it(`refuses ${label} delegation policy at construction`, () => {
      expect(() => setup({ delegations })).toThrow(
        "GITLAB_BRIDGE_PIPELINE_DELEGATIONS",
      );
    });
  }

  it("rejects an unlisted actual author even when the payload claims a delegated author", async () => {
    const t = setup({ noteAuthor: 6 });
    expect((await t.request({ authorId: 5 })).status).toBe(403);
    expect(t.trigger).not.toHaveBeenCalled();
    expect(t.requests.some((r) => r.path.endsWith("/members/all/6"))).toBe(
      true,
    );
    expect(t.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("rejects a newly changed live source branch even when the payload names the allowed ref", async () => {
    const t = setup({ sourceBranch: "unlisted-live-ref" });
    expect((await t.request({ sourceBranch: "feature" })).status).toBe(403);
    expect(t.trigger).not.toHaveBeenCalled();
  });

  it("does not combine separate delegated users and branches into a cross-product", async () => {
    const t = setup({
      delegations: [
        { authorId: 5, sourceBranches: ["main"] },
        { authorId: 6, sourceBranches: ["feature"] },
      ],
    });
    expect((await t.request()).status).toBe(403);
    expect(t.trigger).not.toHaveBeenCalled();
  });

  it("rejects an entire policy containing an invalid row instead of retaining a valid grant", () => {
    expect(() =>
      setup({
        delegations: [
          { authorId: 5, sourceBranches: ["feature"] },
          { authorId: 6, sourceBranches: ["*"] },
        ],
      }),
    ).toThrow("GITLAB_BRIDGE_PIPELINE_DELEGATIONS");
  });

  it("refuses invalid branch-prefix policy instead of interpreting it as a grant", () => {
    expect(() =>
      setup({ delegations: [{ authorId: 5, sourceBranches: ["feature/"] }] }),
    ).toThrow("GITLAB_BRIDGE_PIPELINE_DELEGATIONS");
  });

  it("retains valid but nonmatching exact names as denied", async () => {
    const t = setup({
      delegations: [
        { authorId: 5, sourceBranches: ["Feature", "feature/other"] },
      ],
    });
    expect((await t.request()).status).toBe(403);
    expect(t.trigger).not.toHaveBeenCalled();
  });

  it("keeps validated delegation policy independent of later caller mutations", async () => {
    const delegations = [{ authorId: 6, sourceBranches: ["feature"] }];
    const t = setup({ delegations });
    delegations[0]!.authorId = 5;
    expect((await t.request()).status).toBe(403);
    expect(t.trigger).not.toHaveBeenCalled();
  });

  for (const target of [{ liveProject: 99 }, { liveIid: 8 }]) {
    it(`refuses a live MR outside its configured target ${JSON.stringify(target)}`, async () => {
      const t = setup(target);
      expect((await t.request()).status).toBe(403);
      expect(t.trigger).not.toHaveBeenCalled();
      expect(t.requests.some((r) => r.method === "POST")).toBe(false);
    });
  }

  it("does not grant a delegated expired member pipeline authority", async () => {
    const t = setup({ expiresAt: "2000-01-01" });
    expect((await t.request()).status).toBe(403);
    expect(t.trigger).not.toHaveBeenCalled();
  });

  it("does not dispatch a closed MR even for a delegated author/ref", async () => {
    const t = setup({ state: "closed" });
    expect((await t.request()).status).toBe(200);
    expect(t.trigger).not.toHaveBeenCalled();
  });

  it("retains full head SHA syntax checks alongside delegation", async () => {
    const t = setup({ head: "not-a-full-head" });
    expect((await t.request()).status).toBe(502);
    expect(t.trigger).not.toHaveBeenCalled();
  });

  it("delegates the current exact branch, not a pretend atomic head pin", async () => {
    const t = setup({ head: "b".repeat(40) });
    expect((await t.request()).status).toBe(200);
    expect(t.trigger).toHaveBeenCalledWith({
      ref: "feature",
      mrIid: 7,
      noteId: 20,
    });
  });

  it("shares a pending trigger failure instead of acknowledging its retry", async () => {
    const t = setup();
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let fail = (_error: Error) => {};
    const pending = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    t.trigger.mockImplementation(async () => {
      entered();
      await pending;
    });
    const original = t.request();
    await started;
    const retry = t.request();
    await Promise.resolve();
    await Promise.resolve();
    fail(new Error("controlled trigger failure"));
    expect((await original).status).toBe(502);
    expect((await retry).status).toBe(502);
    expect(t.trigger).toHaveBeenCalledTimes(1);
    t.trigger.mockImplementation(async () => {});
    expect((await t.request()).status).toBe(200);
    expect(t.trigger).toHaveBeenCalledTimes(2);
  });

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
