import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { GitlabClient } from "../../src/gitlab/api/client";
import { resolveReviewUxConfig } from "../../src/core/review/config";
import {
  decodeFindingMarker,
  decodeReviewState,
  encodeFindingMarker,
  encodeReviewState,
  SUMMARY_MARKER,
} from "../../src/core/review/markers";
import { normalizeFinding } from "../../src/core/review/validated/finding";
import {
  assertGitlabFixRef,
  dispatchGitlabCommand,
  publishGitlabFix,
  type CommandExecution,
} from "../../src/gitlab/operations/commands";
import { loadGitlabReviewConfig } from "../../src/gitlab/operations/review-config";
import {
  descriptionWithReview,
  reconcileDiscussionState,
  renderGitlabSummary,
  resolveFixedDiscussions,
  stateFinding,
  updateLifecycleAward,
  updateReviewStatus,
} from "../../src/gitlab/operations/review-ux";
import type { GitlabMr, GitlabNote } from "../../src/gitlab/types";
import {
  json,
  notFound,
  startFakeServer,
  type FakeServer,
} from "../bitbucket/fake-server";
import { postReview } from "../../src/entrypoints/gitlab-post-review";
import { run as postRun } from "../../src/entrypoints/gitlab-post-review";
import { run as prepareRun } from "../../src/entrypoints/gitlab-prepare";
import { run as finishRun } from "../../src/entrypoints/gitlab-update-comment-link";
import { publishGitlabSecurityReport } from "../../src/gitlab/operations/security-report";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as modelPolicy from "../../src/utils/model-policy";
import * as droidSettings from "../../base-action/src/setup-droid-settings";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const FIX = "c".repeat(40);
const finding = normalizeFinding({
  id: "f-retry",
  title: "Requests stop retrying",
  severity: "P1",
  path: "src/x.ts",
  line: 10,
  body: "A dropped connection remains unusable.",
  why: "No reconnect path remains",
  verification: "Traced the caller",
  agent_prompt: "Restore bounded retries",
});
const mr: GitlabMr = {
  id: 70,
  iid: 7,
  project_id: 42,
  title: "Restore connection retries",
  description: "Restore retries after disconnection. Fixes #12.",
  state: "opened",
  author: { id: 5, username: "author" },
  source_branch: "feat/retry",
  target_branch: "main",
  source_project_id: 42,
  target_project_id: 42,
  draft: false,
  work_in_progress: false,
  diff_refs: { head_sha: HEAD, base_sha: BASE, start_sha: BASE },
  web_url: "https://gitlab.com/group/repo/-/merge_requests/7",
  created_at: "2026-10-28T00:00:00Z",
  updated_at: "2026-10-28T00:00:00Z",
};
const note = (id: number, body: string, author = 1): GitlabNote => ({
  id,
  body,
  type: null,
  author: { id: author, username: author === 1 ? "droid" : "author" },
  created_at: mr.created_at,
  updated_at: mr.updated_at,
  system: false,
  noteable_id: mr.id,
  noteable_iid: mr.iid,
  noteable_type: "MergeRequest",
  resolvable: false,
});
const root = note(
  10,
  `Finding\n\n${encodeFindingMarker({ id: finding.id, sev: "P1", head: BASE })}`,
);
const state = {
  head: BASE,
  findings: [
    {
      ...stateFinding(finding),
      threadId: "discussion-1",
      thread: "discussion-1",
      url: `${mr.web_url}#note_10`,
    },
  ],
  autoRunCount: 2,
};
const config = () => resolveReviewUxConfig();
let server: FakeServer | undefined;
afterEach(() => server?.stop());

function setup(
  options: {
    command?: string;
    thread?: boolean;
    actorRole?: number;
    botRole?: number;
    protected?: boolean;
    defaultBranch?: string;
    advance?: boolean;
    humanResolved?: boolean;
    yaml?: string;
    noState?: boolean;
    existingDiscussions?: boolean;
    priorHead?: string;
    draft?: boolean;
    configMode?: string;
    statusDenied?: boolean;
    head?: string;
    advanceAfterMrFetch?: boolean;
    refreshState?: string;
    refreshHead?: string;
    refreshDescription?: string;
    refreshProject?: number;
    refreshNativeId?: number;
  } = {},
) {
  const trigger = note(20, options.command ?? "@droid help", 5);
  const discussion = {
    id: "discussion-1",
    individual_note: false,
    notes: [
      { ...root, resolvable: true, resolved: options.humanResolved ?? false },
      ...(options.thread ? [trigger] : []),
    ],
  };
  const notes = [
    note(
      1,
      `${SUMMARY_MARKER}\n${encodeReviewState(options.noState ? { head: "", findings: [] } : { ...state, head: options.priorHead ?? state.head })}`,
    ),
    trigger,
  ];
  let sourceBranchReads = 0;
  let mrReads = 0;
  server = startFakeServer((req, url) => {
    if (url.pathname === "/api/v4/user")
      return json({ id: 1, username: "droid" });
    if (/\/members\/all\/5$/.test(url.pathname))
      return json({ access_level: options.actorRole ?? 40 });
    if (/\/members\/all\/1$/.test(url.pathname))
      return json({ access_level: options.botRole ?? 40 });
    if (/\/projects\/42$/.test(url.pathname))
      return json({
        id: 42,
        default_branch: options.defaultBranch ?? "main",
        web_url: "https://gitlab.com/group/repo",
      });
    if (url.pathname.includes("/repository/branches/")) {
      const target = url.pathname.endsWith("/main");
      if (!target) sourceBranchReads++;
      return json({
        name: target ? "main" : mr.source_branch,
        protected: options.protected ?? false,
        can_push: !options.protected,
        commit: {
          id: target
            ? BASE
            : options.advance && sourceBranchReads > 1
              ? FIX
              : HEAD,
        },
      });
    }
    if (url.pathname.includes("/repository/files/")) {
      if (
        decodeURIComponent(url.pathname).includes("/.factory/security/reports/")
      )
        return notFound();
      if (decodeURIComponent(url.pathname).endsWith("/.factory/review.yaml"))
        return options.yaml
          ? json({
              encoding: "base64",
              content: Buffer.from(options.yaml).toString("base64"),
            })
          : notFound();
      return json({
        encoding: "base64",
        content: Buffer.from("old code\n").toString("base64"),
        last_commit_id: BASE,
        execute_filemode: false,
      });
    }
    if (url.pathname.endsWith("/repository/tree"))
      return json(
        url.searchParams.get("path") === ".factory"
          ? [
              {
                path: ".factory/review.yaml",
                mode: options.configMode ?? "100644",
                type: "blob",
              },
            ]
          : [{ path: "src/x.ts", mode: "100644", type: "blob" }],
      );
    if (url.pathname.endsWith("/repository/commits") && req.method === "POST")
      return json({
        id: FIX,
        web_url: "https://gitlab.com/group/repo/-/commit/" + FIX,
      });
    if (url.pathname.endsWith("/notes/20")) return json(trigger);
    if (url.pathname.endsWith("/notes") && req.method === "GET")
      return json(notes);
    if (url.pathname.endsWith("/notes") && req.method === "POST") {
      const created = note(99, req.body.body);
      notes.push(created);
      return json(created);
    }
    if (url.pathname.endsWith("/notes/99") && req.method === "PUT") {
      const created = notes.find((n) => n.id === 99);
      if (created) created.body = req.body.body;
      return json(created ?? note(99, req.body.body));
    }
    if (url.pathname.endsWith("/notes/99") && req.method === "GET")
      return json(notes.find((n) => n.id === 99));
    if (url.pathname.endsWith("/notes/1") && req.method === "PUT")
      return json(note(1, "updated"));
    if (url.pathname.endsWith("/notes/1") && req.method === "GET")
      return json(notes[0]);
    if (url.pathname.endsWith("/discussions") && req.method === "GET")
      return json(
        options.noState && !options.existingDiscussions ? [] : [discussion],
      );
    if (url.pathname.endsWith("/discussions") && req.method === "POST")
      return json({
        id: "posted-discussion",
        individual_note: false,
        notes: [note(100, "posted")],
      });
    if (
      url.pathname.endsWith("/discussions/discussion-1") &&
      req.method === "PUT"
    )
      return json(discussion);
    if (url.pathname.endsWith("/changes"))
      return json({
        changes: [
          {
            old_path: "src/x.ts",
            new_path: "src/x.ts",
            diff: "@@ -10 +10 @@\n-old code\n+new code\n",
          },
        ],
        diff_refs: mr.diff_refs,
      });
    if (url.pathname.endsWith("/repository/compare"))
      return json({
        diffs: [
          {
            old_path: "src/x.ts",
            new_path: "src/x.ts",
            diff: "@@ -10 +10 @@\n-old code\n+new code\n",
          },
        ],
      });
    if (url.pathname.endsWith("/award_emoji") && req.method === "GET")
      return json([
        { id: 1, name: "eyes", user: { id: 1 } },
        { id: 2, name: "thumbsup", user: { id: 5 } },
      ]);
    if (url.pathname.endsWith("/award_emoji") && req.method === "POST")
      return json({ id: 3 });
    if (/\/award_emoji\/\d+$/.test(url.pathname) && req.method === "DELETE")
      return new Response(null, { status: 204 });
    if (url.pathname.includes("/statuses/"))
      return options.statusDenied
        ? new Response("Forbidden", { status: 403 })
        : json({ id: 4 });
    if (url.pathname.endsWith("/merge_requests/7") && req.method === "GET") {
      const refreshed = mrReads++ > 0;
      const currentMr = {
        ...mr,
        ...(refreshed
          ? {
              state: options.refreshState ?? mr.state,
              description: options.refreshDescription ?? mr.description,
              project_id: options.refreshProject ?? mr.project_id,
              id: options.refreshNativeId ?? mr.id,
            }
          : {}),
        draft: options.draft ?? false,
        diff_refs: {
          ...mr.diff_refs,
          head_sha: refreshed
            ? (options.refreshHead ?? options.head ?? HEAD)
            : (options.head ?? HEAD),
        },
      };
      if (options.advanceAfterMrFetch) options.head = FIX;
      return json(currentMr);
    }
    if (url.pathname.endsWith("/merge_requests/7") && req.method === "PUT")
      return json({ ...mr, description: req.body.description });
    if (url.pathname.endsWith("/merge_requests") && req.method === "POST")
      return json({
        ...mr,
        web_url: req.body.source_branch.startsWith("droid/security-")
          ? "https://gitlab.com/group/repo/-/merge_requests/8"
          : mr.web_url + "-stacked",
      });
    return notFound();
  });
  return {
    client: new GitlabClient("test-token", `${server.url}/api/v4`),
    discussion,
    notes,
    requests: server.requests,
  };
}

describe("GitLab review UX v2", () => {
  it("reads config only from a full target-branch SHA and honors explicit false/zero", async () => {
    const t = setup({
      yaml: "review_badges: emoji\nreview_max_auto_runs: 5\nreview_incremental: true\n",
    });
    const result = await loadGitlabReviewConfig(t.client, 42, mr, {
      REVIEW_INCREMENTAL: "false",
      REVIEW_MAX_AUTO_RUNS: "0",
    });
    expect(result.review_incremental).toBe(false);
    expect(result.review_max_auto_runs).toBe(0);
    expect(result.review_badges).toBe("emoji");
    expect(result.automatic_review).toBe(true);
    expect(
      t.requests.find((r) => r.path.includes("repository/files"))?.path,
    ).toContain(`ref=${BASE}`);
  });

  it("rejects a symlink config instead of reading its target as YAML", async () => {
    const t = setup({ yaml: "review_badges: emoji", configMode: "120000" });
    await expect(loadGitlabReviewConfig(t.client, 42, mr, {})).rejects.toThrow(
      "regular base-branch file",
    );
  });

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

  it("renders MR summary links, keeps previous context, and escapes model text", () => {
    const body = renderGitlabSummary({
      state: "in_progress",
      head: HEAD,
      previousHead: BASE,
      previousBody: renderGitlabSummary({
        state: "findings",
        head: BASE,
        findings: [
          {
            ...finding,
            title: "Break | [link]",
            threadUrl: `${mr.web_url}#note_10`,
          },
        ],
      }),
    });
    expect(body).toContain("Previous review");
    expect(body).toContain("#note_10");
    expect(body).not.toContain("discussion_r");
  });

  it("uses rich deterministic inline bodies and stable finding markers", async () => {
    const t = setup();
    const seen = mock(() => {});
    await postReview({
      client: t.client,
      projectId: 42,
      mrIid: 7,
      comments: [
        {
          path: finding.path,
          body: finding.body,
          line: 10,
          startLine: null,
          side: "RIGHT",
          old_path: null,
          old_line: null,
          finding,
        },
      ],
      renderOptions: { platform: "gitlab", head: HEAD },
      onPosted: seen,
    });
    const posted = t.requests.find(
      (r) => r.method === "POST" && r.path.endsWith("/discussions"),
    );
    expect(posted?.body.body).toContain("`P1`");
    expect(posted?.body.body).not.toContain("<img");
    expect(posted?.body.body).not.toContain("Why this was flagged");
    expect(decodeFindingMarker(posted?.body.body)).toMatchObject({
      id: finding.id,
      head: HEAD,
    });
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({ threadUrl: `${mr.web_url}#note_100` }),
    );
  });

  it("keeps unanchorable findings in the sticky summary rather than another note", async () => {
    const t = setup();
    const outside = mock(() => {});
    const result = await postReview({
      client: t.client,
      projectId: 42,
      mrIid: 7,
      comments: [
        {
          path: "outside.ts",
          body: finding.body,
          line: 900,
          startLine: null,
          side: "RIGHT",
          old_path: null,
          old_line: null,
          finding: { ...finding, path: "outside.ts", line: 900 },
        },
      ],
      renderOptions: { platform: "gitlab" },
      onOutsideDiff: outside,
    });
    expect(result.fallbackPosted).toBe(1);
    expect(outside).toHaveBeenCalledWith(
      expect.objectContaining({ outside_diff: true }),
    );
    expect(t.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("treats a human-resolved finding as dismissed, never fixed", () => {
    const { discussion } = setup({ humanResolved: true });
    expect(
      reconcileDiscussionState(state, [discussion], 1).findings[0]?.state,
    ).toBe("dismissed");
  });

  it("only resolves a verified owned changed finding and replies with its commit", async () => {
    const t = setup();
    const result = await resolveFixedDiscussions({
      client: t.client,
      projectId: 42,
      mr,
      state,
      discussions: [t.discussion],
      userId: 1,
      fixed: [{ id: finding.id, evidence: "Traced the new reconnect path" }],
      changedPaths: [finding.path],
      enabled: true,
    });
    expect(result.state.findings[0]?.state).toBe("resolved");
    expect(t.requests.find((r) => r.method === "POST")?.body.body).toBe(
      `✅ Fixed in ${HEAD.slice(0, 7)}.`,
    );
    expect(result.resolved).toHaveLength(1);
  });

  it("does not infer a fix from an absent finding or unchanged path", async () => {
    const t = setup();
    const result = await resolveFixedDiscussions({
      client: t.client,
      projectId: 42,
      mr,
      state,
      discussions: [t.discussion],
      userId: 1,
      fixed: [],
      changedPaths: [finding.path],
      enabled: true,
    });
    expect(result.state.findings[0]?.state).toBe("open");
    expect(t.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  it("infers running for an omitted optional status phase", async () => {
    const t = setup();
    await updateReviewStatus(t.client, 42, HEAD, {
      state: "in_progress",
      head: HEAD,
    });
    expect(t.requests.map((r) => r.body.state)).toEqual(["running"]);
  });

  it("preserves explicit queued precedence over the optional status phase", async () => {
    const t = setup();
    await updateReviewStatus(
      t.client,
      42,
      HEAD,
      { state: "in_progress", head: HEAD },
      true,
      "queued",
    );
    expect(t.requests.map((r) => r.body.state)).toEqual(["pending"]);
  });

  it("uses success for nonblocking findings/errors and failed only for thresholds", async () => {
    const t = setup();
    await updateReviewStatus(t.client, 42, HEAD, {
      state: "findings",
      findings: [finding],
      head: HEAD,
    });
    await updateReviewStatus(t.client, 42, HEAD, {
      state: "failed",
      error: "timeout",
      head: HEAD,
    });
    await updateReviewStatus(t.client, 42, HEAD, {
      state: "findings",
      findings: [finding],
      blocked: true,
      head: HEAD,
    });
    expect(t.requests.map((r) => r.body.state)).toEqual([
      "success",
      "success",
      "failed",
    ]);
  });

  it("degrades without failing when commit-status permission is missing", async () => {
    const t = setup({ statusDenied: true });
    await updateReviewStatus(t.client, 42, HEAD, {
      state: "clean",
      head: HEAD,
    });
    expect(t.requests[0]?.body.state).toBe("success");
  });

  it("never lists reactions, removes only its returned eyes ID, and celebrates clean with tada", async () => {
    const t = setup();
    const listAwards = mock(() => {
      throw new Error("Reaction reads are forbidden");
    });
    Object.defineProperty(t.client, "listAwards", { value: listAwards });
    const ownEyes = await updateLifecycleAward(t.client, 42, 7, "running");
    await updateLifecycleAward(t.client, 42, 7, "clean", true, ownEyes);
    expect(t.requests.find((r) => r.method === "DELETE")?.path).toEndWith(
      "/award_emoji/3",
    );
    expect(
      t.requests.filter((r) => r.method === "POST").map((r) => r.body.name),
    ).toEqual(["eyes", "tada"]);
    expect(listAwards).not.toHaveBeenCalled();
    expect(
      t.requests.filter(
        (r) => r.method === "GET" && r.path.includes("award_emoji"),
      ),
    ).toHaveLength(0);
    expect(
      t.requests.filter((r) => r.path.endsWith("/award_emoji/2")),
    ).toHaveLength(0);
  });

  it("preserves author description text outside the summary block", () => {
    const once = descriptionWithReview("Author context", "old summary");
    const twice = descriptionWithReview(once, "new summary");
    expect(twice).toStartWith("Author context\n\n");
    expect(twice).not.toContain("old summary");
    expect(twice.match(/droid-review-description:start/g)).toHaveLength(1);
  });

  it("preserves leading author indentation when appending a description review", () => {
    const description = "    const original = true;\n    inspect(original);";
    const result = descriptionWithReview(description, "summary");
    expect(result.slice(0, description.length)).toBe(description);
    expect(result.slice(description.length)).toBe(
      "\n\n<!-- droid-review-description:start -->\nsummary\n<!-- droid-review-description:end -->",
    );
    const updated = descriptionWithReview(result, "updated summary");
    expect(updated).toBe(result.replace("\nsummary\n", "\nupdated summary\n"));
    expect(updated.match(/droid-review-description:start/g)).toHaveLength(1);
  });

  it("preserves trailing author whitespace and CRLF bytes when appending", () => {
    const description = "Author context  \t\r\n\r\n";
    const result = descriptionWithReview(description, "summary");
    expect(
      Buffer.from(result).subarray(0, Buffer.byteLength(description)),
    ).toEqual(Buffer.from(description));
    expect(result.slice(description.length)).toBe(
      "\n\n<!-- droid-review-description:start -->\nsummary\n<!-- droid-review-description:end -->",
    );
    const updated = descriptionWithReview(result, "updated summary");
    expect(updated).toBe(result.replace("\nsummary\n", "\nupdated summary\n"));
    expect(updated.match(/droid-review-description:start/g)).toHaveLength(1);
  });

  it("keeps author prefix and suffix unchanged when replacing a description review", () => {
    const prefix = "    Author code example\r\n\r\n";
    const suffix = "\r\nAuthor closing context  \t\r\n";
    const previous =
      "<!-- droid-review-description:start -->\nold summary\n<!-- droid-review-description:end -->";
    const next =
      "<!-- droid-review-description:start -->\nnew summary\n<!-- droid-review-description:end -->";
    expect(
      descriptionWithReview(prefix + previous + suffix, "new summary"),
    ).toBe(prefix + next + suffix);
  });

  it("appends a description review without leading separators to an empty description", () => {
    expect(descriptionWithReview("", "summary")).toBe(
      "<!-- droid-review-description:start -->\nsummary\n<!-- droid-review-description:end -->",
    );
  });
  it("does not replace description markers in fenced examples or delete intervening author text", () => {
    const example =
      "```html\n<!-- droid-review-description:start -->\nexample\n<!-- droid-review-description:end -->\n```\n\nAuthor context must survive.";
    const once = descriptionWithReview(example, "old real summary");
    const twice = descriptionWithReview(once, "new real summary");
    expect(twice).toStartWith(example);
    expect(twice).toContain("new real summary");
    expect(twice).not.toContain("old real summary");
  });
});

describe("GitLab command bridge", () => {
  it("fetches the actual note author and refuses non-writers before execution", async () => {
    const t = setup({ command: "@droid fix", actorRole: 20 });
    const execute = mock(async () => "");
    await expect(
      dispatchGitlabCommand({
        client: t.client,
        projectId: 42,
        mr,
        config: config(),
        noteId: 20,
        execute,
      }),
    ).rejects.toThrow("Developer");
    expect(execute).not.toHaveBeenCalled();
    expect(t.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  it("parses security alias/full reviews without executing a command model", async () => {
    const t = setup({ command: "@droid review --full migration locks" });
    const result = await dispatchGitlabCommand({
      client: t.client,
      projectId: 42,
      mr,
      config: config(),
      noteId: 20,
    });
    expect(result.handled).toBe(false);
    expect(result.command).toMatchObject({
      command: "review",
      fullReview: true,
      focus: "migration locks",
    });
  });

  it("does not trigger a fenced command", async () => {
    const t = setup({ command: "```\n@droid fix\n```" });
    expect(
      (
        await dispatchGitlabCommand({
          client: t.client,
          projectId: 42,
          mr,
          config: config(),
          noteId: 20,
        })
      ).handled,
    ).toBe(true);
    expect(t.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  it("answers thread questions in that discussion without starting a review", async () => {
    const t = setup({
      command: "@droid why does this lose retries?",
      thread: true,
    });
    const execute = mock<CommandExecution>(
      async () => "The connection has no retry callback.",
    );
    const result = await dispatchGitlabCommand({
      client: t.client,
      projectId: 42,
      mr,
      config: config(),
      noteId: 20,
      execute,
    });
    expect(result.handled).toBe(true);
    expect(execute.mock.calls[0]?.[1]).toBe("answer");
    expect(t.requests.find((r) => r.method === "POST")?.path).toContain(
      "/discussions/discussion-1/notes",
    );
  });

  it("pause persists a versioned state marker without deleting previous review", async () => {
    const t = setup({ command: "@droid pause" });
    await dispatchGitlabCommand({
      client: t.client,
      projectId: 42,
      mr,
      config: config(),
      noteId: 20,
    });
    const body = t.requests.find((r) => r.method === "PUT")?.body.body;
    expect(decodeReviewState(body)?.paused).toBe(true);
    expect(body).toContain(SUMMARY_MARKER);
  });
});

describe("GitLab fix publisher, API and push mocked", () => {
  for (const stateAfterModel of ["closed", "merged"])
    it(`refuses publication when the MR becomes ${stateAfterModel} during the model`, async () => {
      const t = setup();
      const getMr = t.client.getMr.bind(t.client);
      t.client.getMr = async (...args) => ({
        ...(await getMr(...args)),
        state: stateAfterModel,
      });
      const push = mock(async () => {});
      await expect(publish(t.client, { push })).rejects.toThrow("not open");
      expect(push).not.toHaveBeenCalled();
      expect(t.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    });

  const execute = async () =>
    JSON.stringify({
      summary: "Restored retries",
      files: [{ path: "src/x.ts", content: "new code\n" }],
    });
  const publish = (
    client: GitlabClient,
    extra: Partial<Parameters<typeof publishGitlabFix>[0]> = {},
  ) =>
    publishGitlabFix({
      client,
      mr,
      config: config(),
      findings: state.findings,
      execute,
      context: "",
      actorId: 5,
      push: mock(async () => {}),
      ...extra,
    });

  it("creates an expected-head commit on a fresh branch, then uses non-force push boundary", async () => {
    const t = setup();
    const push = mock(async () => {});
    const body = await publish(t.client, { push });
    const commit = t.requests.find((r) =>
      r.path.endsWith("/repository/commits"),
    );
    expect(commit?.body.start_sha).toBe(HEAD);
    expect(commit?.body.branch).toStartWith("droid/fix-7-");
    expect(commit?.body.force).toBeUndefined();
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "feat/retry", sha: FIX }),
    );
    expect(body).toContain(FIX);
    expect(body).toContain("not independently verified");
  });

  it("refuses the source project's actual default branch before creating a commit", async () => {
    const t = setup({ defaultBranch: "feat/retry" });
    await expect(publish(t.client)).rejects.toThrow("default branch");
    expect(t.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("requires the command author's source-project write permission", async () => {
    const t = setup({ actorRole: 20 });
    await expect(publish(t.client)).rejects.toThrow("command author");
    expect(t.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("refuses a fork without token write permission", async () => {
    const t = setup({ botRole: 20 });
    await expect(
      publish(t.client, { mr: { ...mr, target_project_id: 99 } }),
    ).rejects.toThrow("fork");
    expect(t.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("uses a stacked MR for protected writable branches and never pushes", async () => {
    const t = setup({ protected: true });
    const push = mock(async () => {});
    const body = await publish(t.client, { push });
    expect(push).not.toHaveBeenCalled();
    expect(
      t.requests.find((r) => r.path.endsWith("/merge_requests"))?.body
        .target_branch,
    ).toBe("feat/retry");
    expect(body).toContain("Stacked MR:");
  });

  it("rejects a concurrent branch advance before push", async () => {
    const t = setup({ advance: true });
    const push = mock(async () => {});
    await expect(publish(t.client, { push })).rejects.toThrow("advanced");
    expect(push).not.toHaveBeenCalled();
  });

  for (const branch of [
    "main..x",
    "-option",
    "x.lock",
    "a\nmain",
    "a:main",
    "a@{1}",
    "a//b",
  ])
    it(`refuses unsafe ref ${JSON.stringify(branch)}`, () =>
      expect(() => assertGitlabFixRef(branch, HEAD)).toThrow());
  it("refuses short or model-injected commit SHAs", () =>
    expect(() => assertGitlabFixRef("feat/x", "abc1234")).toThrow(
      "full commit SHA",
    ));
});

describe("GitLab v2 production entrypoints, local API only", () => {
  const keys = [
    ...new Set([
      "CI_PROJECT_ID",
      "CI_PROJECT_PATH",
      "CI_PROJECT_URL",
      "CI_MERGE_REQUEST_IID",
      "CI_COMMIT_SHA",
      "CI_API_V4_URL",
      "CI_PIPELINE_SOURCE",
      "DROID_STATE_FILE",
      "DROID_PROMPT_FILE",
      "REVIEW_POST_RESULTS_PATH",
      "REVIEW_VALIDATED_PATH",
      "GITLAB_TOKEN",
      "OVERRIDE_GITLAB_TOKEN",
      "REVIEW_UX_V2",
      "REVIEW_CONFIG_JSON",
      "DROID_SECURITY_FULL",
      "DROID_SECURITY_ONLY",
      "DROID_REVIEW_HEAD_SHA",
      "DROID_LIFECYCLE_AWARD_CONTEXT",
      "DROID_TRIGGER_NOTE_ID",
      "AUTOMATIC_REVIEW",
      "AUTOMATIC_SECURITY_REVIEW",
      "REVIEW_DEPTH",
      "REVIEW_MODEL",
      "HOME",
      "FACTORY_API_KEY",
      "DROID_PASS1_LOG",
      "DROID_PASS2_LOG",
      "DROID_SUCCESS",
      ...Object.keys(config()).map((key) => key.toUpperCase()),
    ]),
  ];
  async function environment(test: (directory: string) => Promise<void>) {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "droid-gl-v2-entry-"),
    );
    const saved = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, {
      CI_PROJECT_ID: "42",
      CI_PROJECT_PATH: "group/repo",
      CI_PROJECT_URL: "https://gitlab.com/group/repo",
      CI_MERGE_REQUEST_IID: "7",
      CI_COMMIT_SHA: HEAD,
      CI_PIPELINE_SOURCE: "merge_request_event",
      CI_API_V4_URL: `${server?.url}/api/v4`,
      DROID_STATE_FILE: path.join(directory, "state.json"),
      DROID_PROMPT_FILE: path.join(directory, "prompt.txt"),
      REVIEW_POST_RESULTS_PATH: path.join(directory, "results.json"),
      REVIEW_VALIDATED_PATH: path.join(directory, "validated.json"),
      GITLAB_TOKEN: "test-token",
      REVIEW_UX_V2: "true",
      REVIEW_MODEL: "gpt-5.4",
      HOME: directory,
      DROID_PASS1_LOG: path.join(directory, "missing1.jsonl"),
      DROID_PASS2_LOG: path.join(directory, "missing2.jsonl"),
    });
    const settings = spyOn(
      droidSettings,
      "setupDroidSettings",
    ).mockResolvedValue(undefined);
    const pending: Promise<Response>[] = [];
    const fetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (...args: Parameters<typeof fetch>) => {
        const request = fetch(...args).then(async (response) => {
          await response.clone().arrayBuffer();
          return response;
        });
        pending.push(request);
        return request;
      },
      { preconnect: fetch.preconnect },
    );
    try {
      if (process.env.DROID_VALIDATION_HOME)
        expect(os.homedir()).toBe(process.env.DROID_VALIDATION_HOME);
      await test(directory);
    } finally {
      // A preparation fault can leave sibling Promise.all reads in flight.
      await Promise.allSettled(pending);
      globalThis.fetch = fetch;
      settings.mockRestore();
      // Preparation exports every resolved setting into this process.
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  it("prepares real artifacts, a rich progress note and queued/running statuses", async () => {
    const t = setup({ noState: true });
    await environment(async (directory) => {
      await prepareRun();
      const prepared = JSON.parse(
        await fs.readFile(path.join(directory, "state.json"), "utf8"),
      );
      expect(prepared.shouldRunReview).toBe(true);
      expect(prepared.reviewConfig.review_badges).toBe("text");
      expect(
        await fs.readFile(path.join(directory, "resolved-env.sh"), "utf8"),
      ).toContain(
        'DROID_LIFECYCLE_AWARD_CONTEXT=\'{"projectId":"42","mrIid":7,"id":3}\'',
      );
      expect(
        await fs.readFile(path.join(directory, "prompt.txt"), "utf8"),
      ).toContain("Trusted review settings");
      expect(
        t.requests
          .filter((r) => r.path.includes("/statuses/"))
          .map((r) => r.body.state),
      ).toEqual(["pending", "running"]);
      expect(t.requests.find((r) => r.method === "PUT")?.body.body).toContain(
        "[!NOTE]",
      );
    });
  });

  describe("pre-binding preparation compensation", () => {
    for (const phase of [
      "artifact",
      "policy",
      "prompt",
      "shim",
      "initial-cache",
      "final-cache",
    ]) {
      it(`compensates a ${phase} failure with the original trusted target and error`, async () => {
        const t = setup({ noState: true });
        await environment(async () => {
          const original = new Error(`controlled ${phase} failure`);
          const write = fs.writeFile;
          let stateWrites = 0;
          const writes = spyOn(fs, "writeFile").mockImplementation(
            async (file, data, options) => {
              const name = path.basename(String(file));
              if (name === "state.json") stateWrites++;
              if (
                (phase === "artifact" && name === "mr.diff") ||
                (phase === "prompt" && name === "prompt.txt") ||
                (phase === "shim" && name === "resolved-env.sh") ||
                (phase === "initial-cache" &&
                  name === "state.json" &&
                  stateWrites === 1) ||
                (phase === "final-cache" &&
                  name === "state.json" &&
                  stateWrites === 2)
              )
                throw original;
              return write(file, data, options);
            },
          );
          const policy =
            phase === "policy"
              ? spyOn(
                  modelPolicy,
                  "applyModelPolicyFallback",
                ).mockImplementation(async () => {
                  throw original;
                })
              : null;
          try {
            await expect(prepareRun()).rejects.toBe(original);
            const updates = t.requests.filter(
              (r) => r.method === "PUT" && r.path.endsWith("/notes/1"),
            );
            expect(updates).toHaveLength(2);
            expect(updates[1]!.body.body).toContain(
              "Review preparation failed",
            );
            expect(decodeReviewState(updates[1]!.body.body)?.head).toBe("");
            expect(decodeReviewState(updates[1]!.body.body)?.findings).toEqual(
              [],
            );
            expect(updates[0]!.body.body).toContain(
              `Droid is reviewing \`${HEAD.slice(0, 7)}\``,
            );
            const statuses = t.requests.filter((r) =>
              r.path.includes("/statuses/"),
            );
            expect(statuses.at(-1)?.body.state).toBe("success");
            expect(statuses.at(-1)?.body.description).toContain("failed");
            expect(
              statuses.every((r) =>
                r.path.endsWith(`/projects/42/statuses/${HEAD}`),
              ),
            ).toBe(true);
            const awards = t.requests.filter(
              (r) => r.method === "POST" && r.path.endsWith("/award_emoji"),
            );
            expect(awards.map((r) => r.body.name)).toEqual(
              phase === "initial-cache" ? [] : ["eyes", "confused"],
            );
            expect(
              t.requests
                .filter((r) => r.method === "DELETE")
                .map((r) => r.path),
            ).toEqual(
              phase === "initial-cache"
                ? []
                : ["/api/v4/projects/42/merge_requests/7/award_emoji/3"],
            );
            expect(
              t.requests.some(
                (r) => r.method === "GET" && r.path.endsWith("/award_emoji"),
              ),
            ).toBe(false);
          } finally {
            writes.mockRestore();
            policy?.mockRestore();
          }
        });
      });
    }

    for (const refreshed of [
      { refreshState: "closed" },
      { refreshHead: FIX },
      { refreshProject: 99 },
      { refreshNativeId: 700 },
    ]) {
      it(`does not compensate an ineligible refreshed MR ${JSON.stringify(refreshed)}`, async () => {
        const t = setup({ noState: true, ...refreshed });
        await environment(async () => {
          const original = new Error("controlled artifact failure");
          const write = fs.writeFile;
          const writes = spyOn(fs, "writeFile").mockImplementation(
            async (file, data, options) => {
              if (path.basename(String(file)) === "mr.diff") throw original;
              return write(file, data, options);
            },
          );
          try {
            await expect(prepareRun()).rejects.toBe(original);
            expect(
              t.requests.filter(
                (r) => r.path.endsWith("/notes/1") && r.method === "PUT",
              ),
            ).toHaveLength(1);
            expect(
              t.requests
                .filter((r) => r.path.includes("/statuses/"))
                .map((r) => r.body.state),
            ).toEqual(["pending", "running"]);
            expect(
              t.requests.filter((r) => r.method === "DELETE"),
            ).toHaveLength(0);
            expect(
              t.requests
                .filter(
                  (r) => r.path.endsWith("/award_emoji") && r.method === "POST",
                )
                .map((r) => r.body.name),
            ).toEqual(["eyes"]);
          } finally {
            writes.mockRestore();
          }
        });
      });
    }

    it("ignores poisoned mutable target/cache/award hints during lexical compensation", async () => {
      const t = setup({ noState: true });
      await environment(async (directory) => {
        const original = new Error("controlled artifact failure");
        const write = fs.writeFile;
        const writes = spyOn(fs, "writeFile").mockImplementation(
          async (file, data, options) => {
            if (path.basename(String(file)) === "mr.diff") {
              await write(
                path.join(directory, "state.json"),
                JSON.stringify({
                  projectId: 99,
                  mrIid: 8,
                  trackingNoteId: 666,
                }),
              );
              process.env.CI_PROJECT_ID = "99";
              process.env.CI_MERGE_REQUEST_IID = "8";
              process.env.DROID_LIFECYCLE_AWARD_CONTEXT =
                '{"projectId":"99","mrIid":8,"id":2}';
              throw original;
            }
            return write(file, data, options);
          },
        );
        try {
          await expect(prepareRun()).rejects.toBe(original);
          expect(
            t.requests.filter((r) => r.method === "DELETE").map((r) => r.path),
          ).toEqual(["/api/v4/projects/42/merge_requests/7/award_emoji/3"]);
          expect(
            t.requests
              .filter((r) => r.method !== "GET")
              .every((r) => r.path.includes("/projects/42/")),
          ).toBe(true);
          expect(t.requests.some((r) => r.path.includes("/notes/666"))).toBe(
            false,
          );
        } finally {
          writes.mockRestore();
        }
      });
    });

    it("does not mutate anything when preparation fails before its first lifecycle mutation", async () => {
      const t = setup({ noState: true });
      const original = new Error("controlled pre-start failure");
      const changes = spyOn(
        GitlabClient.prototype,
        "getMrChanges",
      ).mockImplementation(async () => {
        throw original;
      });
      try {
        await environment(async () => {
          await expect(prepareRun()).rejects.toBe(original);
          expect(t.requests.some((r) => r.method !== "GET")).toBe(false);
        });
      } finally {
        changes.mockRestore();
      }
    });

    it("retains an existing configured blocking finding when the first cache write fails", async () => {
      const t = setup({ priorHead: HEAD, yaml: "fail_on_severity: P1" });
      await environment(async () => {
        const original = new Error("controlled initial cache failure");
        const write = fs.writeFile;
        const writes = spyOn(fs, "writeFile").mockImplementation(
          async (file, data, options) => {
            if (path.basename(String(file)) === "state.json") throw original;
            return write(file, data, options);
          },
        );
        try {
          await expect(prepareRun()).rejects.toBe(original);
          expect(
            t.requests
              .filter((r) => r.path.includes("/statuses/"))
              .map((r) => r.body.state),
          ).toEqual(["failed"]);
          const updated = t.requests
            .filter((r) => r.path.endsWith("/notes/1") && r.method === "PUT")
            .at(-1);
          expect(decodeReviewState(updated?.body.body)?.findings[0]?.id).toBe(
            finding.id,
          );
          expect(t.requests.some((r) => r.path.includes("/award_emoji"))).toBe(
            false,
          );
        } finally {
          writes.mockRestore();
        }
      });
    });

    it("preserves the original error when the fresh MR lookup itself fails", async () => {
      const t = setup({ noState: true });
      await environment(async () => {
        const original = new Error("controlled artifact failure");
        const get = GitlabClient.prototype.getMr;
        let reads = 0;
        const refresh = spyOn(
          GitlabClient.prototype,
          "getMr",
        ).mockImplementation(async function (
          this: GitlabClient,
          ...args: Parameters<GitlabClient["getMr"]>
        ) {
          if (++reads > 1)
            throw new Error("controlled cleanup refresh failure");
          return get.apply(this, args);
        });
        const write = fs.writeFile;
        const writes = spyOn(fs, "writeFile").mockImplementation(
          async (file, data, options) => {
            if (path.basename(String(file)) === "mr.diff") throw original;
            return write(file, data, options);
          },
        );
        try {
          await expect(prepareRun()).rejects.toBe(original);
          expect(reads).toBe(2);
          expect(
            t.requests
              .filter((r) => r.path.includes("/statuses/"))
              .map((r) => r.body.state),
          ).toEqual(["pending", "running"]);
          expect(t.requests.some((r) => r.method === "DELETE")).toBe(false);
        } finally {
          writes.mockRestore();
          refresh.mockRestore();
        }
      });
    });

    it("preserves freshly edited description text outside its review delimiter", async () => {
      const fresh =
        "Fresh human intro\n\n<!-- droid-review-description:start -->\nold review\n<!-- droid-review-description:end -->\n\nFresh human footer";
      const t = setup({
        noState: true,
        yaml: "review_summary: description",
        refreshDescription: fresh,
      });
      await environment(async () => {
        const original = new Error("controlled artifact failure");
        const write = fs.writeFile;
        const writes = spyOn(fs, "writeFile").mockImplementation(
          async (file, data, options) => {
            if (path.basename(String(file)) === "mr.diff") throw original;
            return write(file, data, options);
          },
        );
        try {
          await expect(prepareRun()).rejects.toBe(original);
          const descriptions = t.requests.filter(
            (r) => r.method === "PUT" && r.path.endsWith("/merge_requests/7"),
          );
          expect(descriptions).toHaveLength(2);
          expect(descriptions[1]!.body.description).toContain(
            "Fresh human intro",
          );
          expect(descriptions[1]!.body.description).toContain(
            "Fresh human footer",
          );
          expect(descriptions[1]!.body.description).toContain(
            "Review preparation failed",
          );
          expect(
            descriptions[1]!.body.description.startsWith(
              "Fresh human intro\n\n",
            ),
          ).toBe(true);
          expect(
            descriptions[1]!.body.description.endsWith(
              "\n\nFresh human footer",
            ),
          ).toBe(true);
          expect(descriptions[1]!.body.description).not.toContain("old review");
        } finally {
          writes.mockRestore();
        }
      });
    });

    for (const changed of [
      { id: 888 },
      { author: { id: 5, username: "human" } },
      { noteable_id: 700 },
      { noteable_iid: 8 },
    ]) {
      it(`does not edit a known-ID note failing fresh ownership/target checks ${JSON.stringify(changed)}`, async () => {
        const t = setup({ noState: true });
        await environment(async () => {
          const original = new Error("controlled artifact failure");
          const write = fs.writeFile;
          const writes = spyOn(fs, "writeFile").mockImplementation(
            async (file, data, options) => {
              if (path.basename(String(file)) === "mr.diff") {
                Object.assign(t.notes[0]!, changed);
                throw original;
              }
              return write(file, data, options);
            },
          );
          try {
            await expect(prepareRun()).rejects.toBe(original);
            expect(
              t.requests.filter(
                (r) => r.path.endsWith("/notes/1") && r.method === "PUT",
              ),
            ).toHaveLength(1);
            expect(
              t.requests.filter((r) => r.path.includes("/statuses/")).at(-1)
                ?.body.state,
            ).toBe("success");
            expect(
              t.requests
                .filter((r) => r.method === "DELETE")
                .map((r) => r.path),
            ).toEqual(["/api/v4/projects/42/merge_requests/7/award_emoji/3"]);
          } finally {
            writes.mockRestore();
          }
        });
      });
    }

    it("compensates only the actual newly created note ID", async () => {
      const t = setup({ noState: true });
      t.notes.splice(0, 1);
      await environment(async () => {
        const original = new Error("controlled artifact failure");
        const write = fs.writeFile;
        const writes = spyOn(fs, "writeFile").mockImplementation(
          async (file, data, options) => {
            if (path.basename(String(file)) === "mr.diff") throw original;
            return write(file, data, options);
          },
        );
        try {
          await expect(prepareRun()).rejects.toBe(original);
          const updates = t.requests.filter(
            (r) => r.path.endsWith("/notes/99") && r.method === "PUT",
          );
          expect(updates).toHaveLength(1);
          expect(updates[0]!.body.body).toContain("Review preparation failed");
          expect(t.requests.some((r) => r.path.endsWith("/notes/1"))).toBe(
            false,
          );
        } finally {
          writes.mockRestore();
        }
      });
    });

    it("never adopts a lost creation-response award ID", async () => {
      const t = setup({ noState: true });
      await environment(async () => {
        const original = new Error("controlled artifact failure");
        const write = fs.writeFile;
        const addAward = GitlabClient.prototype.addAward;
        const lost = spyOn(
          GitlabClient.prototype,
          "addAward",
        ).mockImplementation(async function (
          this: GitlabClient,
          ...args: Parameters<GitlabClient["addAward"]>
        ) {
          await addAward.apply(this, args);
          throw new Error("controlled lost creation response");
        });
        const writes = spyOn(fs, "writeFile").mockImplementation(
          async (file, data, options) => {
            if (path.basename(String(file)) === "mr.diff") throw original;
            return write(file, data, options);
          },
        );
        try {
          await expect(prepareRun()).rejects.toBe(original);
          expect(
            t.requests
              .filter(
                (r) => r.method === "POST" && r.path.endsWith("/award_emoji"),
              )
              .map((r) => r.body.name),
          ).toEqual(["eyes"]);
          expect(t.requests.some((r) => r.method === "DELETE")).toBe(false);
          expect(
            t.requests.some(
              (r) => r.method === "GET" && r.path.endsWith("/award_emoji"),
            ),
          ).toBe(false);
          expect(
            t.requests
              .filter((r) => r.path.endsWith("/notes/1") && r.method === "PUT")
              .at(-1)?.body.body,
          ).toContain("Review preparation failed");
        } finally {
          writes.mockRestore();
          lost.mockRestore();
        }
      });
    });

    it("rethrows the identical original failure even when every cleanup API fails", async () => {
      const t = setup({ noState: true });
      await environment(async () => {
        const original = new Error("controlled artifact failure");
        const write = fs.writeFile;
        const update = GitlabClient.prototype.updateNote;
        let noteCalls = 0;
        const updates = spyOn(
          GitlabClient.prototype,
          "updateNote",
        ).mockImplementation(async function (
          this: GitlabClient,
          ...args: Parameters<GitlabClient["updateNote"]>
        ) {
          if (++noteCalls > 1)
            throw new Error("controlled note cleanup failure");
          return update.apply(this, args);
        });
        const status = GitlabClient.prototype.setCommitStatus;
        let statusCalls = 0;
        const statuses = spyOn(
          GitlabClient.prototype,
          "setCommitStatus",
        ).mockImplementation(async function (
          this: GitlabClient,
          ...args: Parameters<GitlabClient["setCommitStatus"]>
        ) {
          if (++statusCalls > 2)
            throw new Error("controlled status cleanup failure");
          return status.apply(this, args);
        });
        const remove = spyOn(
          GitlabClient.prototype,
          "removeAward",
        ).mockImplementation(async () => {
          throw new Error("controlled award cleanup failure");
        });
        const writes = spyOn(fs, "writeFile").mockImplementation(
          async (file, data, options) => {
            if (path.basename(String(file)) === "mr.diff") throw original;
            return write(file, data, options);
          },
        );
        try {
          await expect(prepareRun()).rejects.toBe(original);
          expect(noteCalls).toBe(2);
          expect(statusCalls).toBe(3);
          expect(remove).toHaveBeenCalledWith("42", 7, 3);
          expect(
            t.requests
              .filter(
                (r) => r.path.endsWith("/award_emoji") && r.method === "POST",
              )
              .map((r) => r.body.name),
          ).toEqual(["eyes"]);
        } finally {
          writes.mockRestore();
          updates.mockRestore();
          statuses.mockRestore();
          remove.mockRestore();
        }
      });
    });
  });

  it("skips identical heads without erasing prior state or invoking model passes", async () => {
    const t = setup({ priorHead: HEAD });
    await environment(async (directory) => {
      await prepareRun();
      const prepared = JSON.parse(
        await fs.readFile(path.join(directory, "state.json"), "utf8"),
      );
      expect(prepared.shouldRunReview).toBe(false);
      expect(prepared.reason).toBe(`No new changes since ${HEAD.slice(0, 7)}`);
      expect(prepared.reviewState.findings[0].id).toBe(finding.id);
      expect(t.requests.find((r) => r.method === "PUT")?.body.body).toContain(
        "[!IMPORTANT]",
      );
    });
  });

  const skipGateCases: {
    name: string;
    yaml?: string;
    finding?: Partial<typeof finding>;
    priorHead?: string;
    paused?: boolean;
    empty?: boolean;
    humanResolved?: boolean;
    previousFailure?: boolean;
    status: "failed" | "skipped" | "off";
  }[] = [
    {
      name: "retains the failed P1 gate on a same-head retry",
      yaml: "fail_on_severity: P1",
      previousFailure: true,
      status: "failed",
    },
    {
      name: "honors the exact P0 threshold",
      yaml: "fail_on_severity: P0",
      finding: { severity: "P0" },
      status: "failed",
    },
    {
      name: "does not block P1 at the P0 threshold",
      yaml: "fail_on_severity: P0",
      status: "skipped",
    },
    {
      name: "does not block P2 at the P1 threshold",
      yaml: "fail_on_severity: P1",
      finding: { severity: "P2" },
      status: "skipped",
    },
    { name: "keeps nonblocking defaults", status: "skipped" },
    {
      name: "preserves the historical orphan classification gate",
      finding: { category: "recovered-unclassified", severity: "P2" },
      status: "failed",
    },
    {
      name: "uses the configured high policy for an unclassified orphan",
      yaml: "security_block_on_critical: false\nsecurity_block_on_high: true",
      finding: { category: "recovered-unclassified", severity: "P2" },
      status: "failed",
    },
    {
      name: "keeps historical orphans nonblocking with security policies off",
      yaml: "security_block_on_critical: false\nsecurity_block_on_high: false",
      finding: { category: "recovered-unclassified", severity: "P2" },
      status: "skipped",
    },
    {
      name: "does not block a human-resolved unclassified orphan",
      humanResolved: true,
      finding: { category: "recovered-unclassified", severity: "P2" },
      status: "skipped",
    },
    {
      name: "does not block a dismissed unclassified orphan",
      finding: {
        category: "recovered-unclassified",
        severity: "P2",
        state: "dismissed",
      },
      status: "skipped",
    },
    {
      name: "blocks retained critical security findings by default",
      finding: { security: true, securitySeverity: "critical" },
      status: "failed",
    },
    {
      name: "keeps high security findings nonblocking by default",
      finding: { security: true, securitySeverity: "high" },
      status: "skipped",
    },
    {
      name: "honors the high security blocking setting",
      yaml: "security_block_on_high: true",
      finding: { security: true, securitySeverity: "high" },
      status: "failed",
    },
    {
      name: "honors disabled critical blocking",
      yaml: "security_block_on_critical: false",
      finding: { security: true, securitySeverity: "critical" },
      status: "skipped",
    },
    {
      name: "includes critical findings at the high security threshold",
      yaml: "security_block_on_critical: false\nsecurity_block_on_high: true",
      finding: { security: true, securitySeverity: "critical" },
      status: "failed",
    },
    {
      name: "does not block medium security at the high threshold",
      yaml: "security_block_on_high: true",
      finding: { security: true, securitySeverity: "medium" },
      status: "skipped",
    },
    {
      name: "ignores already resolved findings",
      yaml: "fail_on_severity: P1",
      finding: { state: "resolved" },
      status: "skipped",
    },
    {
      name: "honors human dismissal before recomputing the gate",
      yaml: "fail_on_severity: P1",
      humanResolved: true,
      status: "skipped",
    },
    {
      name: "keeps no-issues skips nonblocking",
      empty: true,
      status: "skipped",
    },
    {
      name: "keeps a paused review with no issues nonblocking",
      paused: true,
      empty: true,
      status: "skipped",
    },
    {
      name: "does not clear a same-head blocking gate when paused",
      yaml: "fail_on_severity: P1",
      paused: true,
      status: "failed",
    },
    {
      name: "does not copy a prior-head failure onto a paused new head",
      yaml: "fail_on_severity: P1",
      paused: true,
      priorHead: BASE,
      status: "skipped",
    },
    {
      name: "keeps out-of-scope new-head skips unchanged",
      yaml: "fail_on_severity: P1\nreview_ignore_paths: ['src/**']",
      priorHead: BASE,
      status: "skipped",
    },
    {
      name: "honors disabled commit statuses",
      yaml: "fail_on_severity: P1\nreview_check_run: false",
      status: "off",
    },
  ];
  for (const testCase of skipGateCases)
    it(`skip gate: ${testCase.name}`, async () => {
      const t = setup({
        priorHead: testCase.priorHead ?? HEAD,
        yaml: testCase.yaml,
        humanResolved: testCase.humanResolved,
      });
      const retained = {
        ...finding,
        threadId: "discussion-1",
        ...testCase.finding,
      };
      t.notes[0]!.body = `${SUMMARY_MARKER}\n${encodeReviewState({
        ...state,
        head: testCase.priorHead ?? HEAD,
        paused: testCase.paused,
        findings: testCase.empty ? [] : [stateFinding(retained)],
      })}`;
      await environment(async (directory) => {
        if (testCase.previousFailure)
          await updateReviewStatus(t.client, 42, HEAD, {
            platform: "gitlab",
            state: "findings",
            head: HEAD,
            findings: [retained],
            blocked: true,
          });
        await prepareRun();
        const prepared = JSON.parse(
          await fs.readFile(path.join(directory, "state.json"), "utf8"),
        );
        expect(prepared.shouldRunReview).toBe(false);
        if (testCase.paused) expect(prepared.reason).toContain("paused");
        else if (testCase.priorHead)
          expect(prepared.reason).toContain("all changed files are excluded");
        else expect(prepared.reason).toContain("No new changes");
        expect(prepared.reviewState.findings).toHaveLength(
          testCase.empty ? 0 : 1,
        );
        if (testCase.humanResolved)
          expect(prepared.reviewState.findings[0].state).toBe("dismissed");
        await postRun();
        await finishRun();
        const statuses = t.requests.filter((r) =>
          r.path.includes("/statuses/"),
        );
        expect(statuses.map((r) => r.body.state)).toEqual(
          testCase.previousFailure
            ? ["failed", "failed"]
            : testCase.status === "off"
              ? []
              : [testCase.status],
        );
        for (const status of statuses) {
          expect(status.path).toBe(`/api/v4/projects/42/statuses/${HEAD}`);
          expect(status.body.name).toBe("Droid Review");
        }
        await expect(
          fs.stat(path.join(directory, "prompt.txt")),
        ).rejects.toThrow();
      });
    });

  it("GitLab diff contract prepares eligible old-side findings from real API hunks", async () => {
    const t = setup();
    await environment(async (directory) => {
      process.env.REVIEW_MODEL = "gpt-5.4";
      await prepareRun();
      const previous = JSON.parse(
        await fs.readFile(
          path.join(directory, "previous_findings.json"),
          "utf8",
        ),
      );
      expect(previous.eligibleFixedIds).toEqual([finding.id]);
      expect(previous.verifyFixed.map((f: { id: string }) => f.id)).toEqual([
        finding.id,
      ]);
      expect(
        await fs.readFile(path.join(directory, "mr.diff"), "utf8"),
      ).toContain("--- a/src/x.ts\n+++ b/src/x.ts\n@@");
      expect(
        t.requests.find((r) => r.path.includes("/repository/compare"))?.path,
      ).toContain(`from=${BASE}&to=${HEAD}`);
    });
  });

  for (const full of [true, false])
    it(`repository security audit ignores empty MR scope only when full=${full}`, async () => {
      const t = setup({
        command: full ? "@droid security --full" : "@droid security",
        noState: true,
        yaml: "review_ignore_paths: ['src/**']",
      });
      await environment(async (directory) => {
        process.env.DROID_TRIGGER_NOTE_ID = "20";
        process.env.REVIEW_MODEL = "gpt-5.4";
        await prepareRun();
        const prepared = JSON.parse(
          await fs.readFile(path.join(directory, "state.json"), "utf8"),
        );
        expect(prepared.shouldRunReview).toBe(full);
        if (full) {
          expect(
            await fs.readFile(path.join(directory, "mr.diff"), "utf8"),
          ).toBe("");
          expect(prepared.fullReview).toBe(true);
        }
        expect(t.requests.some((r) => r.path.endsWith("/notes/20"))).toBe(true);
      });
    });

  for (const testCase of [
    {
      name: "changed old line with evidence",
      line: 10,
      evidence: "Traced the replacement",
      resolves: true,
    },
    {
      name: "unchanged context line",
      line: 9,
      evidence: "Traced the replacement",
      resolves: false,
    },
    { name: "missing evidence", line: 10, evidence: " ", resolves: false },
    {
      name: "unknown finding ID",
      line: 10,
      evidence: "Traced the replacement",
      id: "unknown",
      resolves: false,
    },
    {
      name: "disabled auto-resolution",
      line: 10,
      evidence: "Traced the replacement",
      yaml: "review_auto_resolve: false",
      resolves: false,
    },
    {
      name: "human dismissal",
      line: 10,
      evidence: "Traced the replacement",
      humanResolved: true,
      resolves: false,
    },
  ])
    it(`GitLab diff contract post resolution: ${testCase.name}`, async () => {
      const t = setup({
        yaml: testCase.yaml,
        humanResolved: testCase.humanResolved,
      });
      t.notes[0]!.body = `${SUMMARY_MARKER}\n${encodeReviewState({
        ...state,
        findings: [
          stateFinding({
            ...finding,
            line: testCase.line,
            threadId: "discussion-1",
          }),
        ],
      })}`;
      await environment(async (directory) => {
        process.env.DROID_REVIEW_HEAD_SHA = HEAD;
        await fs.writeFile(
          path.join(directory, "state.json"),
          JSON.stringify({
            shouldRunReview: true,
            projectId: "42",
            mrIid: 7,
            trackingNoteId: 1,
            headSha: HEAD,
            validatedPath: path.join(directory, "validated.json"),
            reviewConfig: config(),
          }),
        );
        await fs.writeFile(
          path.join(directory, "validated.json"),
          JSON.stringify({
            meta: { headSha: HEAD },
            results: [],
            findingResolutions: [
              {
                id: testCase.id ?? finding.id,
                status: "fixed",
                evidence: testCase.evidence,
              },
            ],
          }),
        );
        await postRun();
        const result = JSON.parse(
          await fs.readFile(path.join(directory, "results.json"), "utf8"),
        );
        const resolutions = t.requests.filter(
          (r) =>
            r.method === "PUT" && r.path.endsWith("/discussions/discussion-1"),
        );
        expect(resolutions).toHaveLength(testCase.resolves ? 1 : 0);
        if (testCase.resolves) expect(resolutions[0]!.body.resolved).toBe(true);
        expect(
          result.renderInput.resolved.map((f: { id: string }) => f.id),
        ).toEqual(testCase.resolves ? [finding.id] : []);
        expect(result.renderInput.reviewState.findings[0].state).toBe(
          testCase.resolves
            ? "resolved"
            : testCase.humanResolved
              ? "dismissed"
              : "open",
        );
      });
    });

  it("renders draft skips and writes the skipped-file manifest", async () => {
    const t = setup({ draft: true });
    await environment(async (directory) => {
      await prepareRun();
      const prepared = JSON.parse(
        await fs.readFile(path.join(directory, "state.json"), "utf8"),
      );
      expect(prepared.reason).toContain("draft MR");
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(directory, "review_files_skipped.json"),
            "utf8",
          ),
        ),
      ).toEqual([]);
      expect(t.requests.find((r) => r.method === "PUT")?.body.body).toContain(
        "draft MR",
      );
    });
  });

  it("posts from structured JSON and completes the same sticky note with a linked finding", async () => {
    const t = setup({ noState: true });
    await environment(async (directory) => {
      process.env.DROID_LIFECYCLE_AWARD_CONTEXT = JSON.stringify(
        await updateLifecycleAward(t.client, 42, 7, "running"),
      );
      await fs.writeFile(
        path.join(directory, "state.json"),
        JSON.stringify({
          shouldRunReview: true,
          projectId: "42",
          mrIid: 7,
          trackingNoteId: 1,
          validatedPath: path.join(directory, "validated.json"),
          reviewConfig: config(),
          securityReviewEnabled: true,
          automatic: false,
        }),
      );
      await fs.writeFile(
        path.join(directory, "validated.json"),
        JSON.stringify({
          meta: { headSha: HEAD },
          results: [{ status: "approved", comment: finding }],
          reviewSummary: { whatChanged: "Restores retry handling" },
        }),
      );
      await postRun();
      const posted = JSON.parse(
        await fs.readFile(path.join(directory, "results.json"), "utf8"),
      );
      expect(posted.renderInput.findings[0].threadUrl).toBe(
        `${mr.web_url}#note_100`,
      );
      expect(posted.renderInput.reviewState.head).toBe(HEAD);
      // The real note-id verification endpoint is absent in this fixture, so
      // the adapter falls back to its author-verified paginated note lookup.
      await finishRun();
      const completed = t.requests.filter((r) => r.method === "PUT").at(-1)
        ?.body.body;
      expect(completed).toContain("Changes recommended");
      expect(completed).toContain("#note_100");
      expect(decodeReviewState(completed)?.findings[0]?.id).toBe(finding.id);
      expect(
        t.requests.some(
          (r) => r.method === "DELETE" && r.path.endsWith("/award_emoji/3"),
        ),
      ).toBe(true);
      expect(
        t.requests.filter(
          (r) => r.method === "GET" && r.path.includes("award_emoji"),
        ),
      ).toHaveLength(0);
    });
  });

  const finalizerHeadCases: {
    name: string;
    trustedHead?: string | null;
    liveHead?: string;
    postedHead?: string;
    removePostedHead?: boolean;
    missingResults?: boolean;
    advanceAfterFetch?: boolean;
    ciCommitSha?: string;
    publishes?: boolean;
  }[] = [
    { name: "skips a new live head after posting the original", liveHead: FIX },
    { name: "completes the unchanged reviewed head", publishes: true },
    { name: "rejects a mismatched posted head", postedHead: FIX },
    {
      name: "rejects forged posted/live agreement",
      postedHead: FIX,
      liveHead: FIX,
    },
    { name: "skips without a trusted parent binding", trustedHead: null },
    { name: "skips malformed parent bindings", trustedHead: "abc1234" },
    { name: "rejects a different full parent binding", trustedHead: FIX },
    { name: "rejects present results without a head", removePostedHead: true },
    {
      name: "preserves a friendly failed status on the trusted head without results",
      missingResults: true,
      publishes: true,
    },
    {
      name: "skips a changed live head without results",
      missingResults: true,
      liveHead: FIX,
    },
    {
      name: "skips preparation failure before parent binding capture",
      missingResults: true,
      trustedHead: null,
    },
    {
      name: "pins the status URI when the head advances after the live fetch",
      advanceAfterFetch: true,
      publishes: true,
    },
    {
      name: "does not use CI_COMMIT_SHA as status authority",
      ciCommitSha: BASE,
      publishes: true,
    },
  ];
  for (const testCase of finalizerHeadCases)
    it(`finalizer status head: ${testCase.name}`, async () => {
      const options = { noState: true, head: HEAD, advanceAfterMrFetch: false };
      const t = setup(options);
      await environment(async (directory) => {
        process.env.DROID_REVIEW_HEAD_SHA = HEAD;
        process.env.DROID_LIFECYCLE_AWARD_CONTEXT = JSON.stringify(
          await updateLifecycleAward(t.client, 42, 7, "running"),
        );
        await fs.writeFile(
          path.join(directory, "state.json"),
          JSON.stringify({
            shouldRunReview: true,
            projectId: "42",
            mrIid: 7,
            trackingNoteId: 1,
            validatedPath: path.join(directory, "validated.json"),
            reviewConfig: config(),
          }),
        );
        await fs.writeFile(
          path.join(directory, "validated.json"),
          JSON.stringify({
            meta: { headSha: HEAD },
            results: [],
            reviewSummary: { whatChanged: "Reviewed the original commit" },
          }),
        );
        if (testCase.missingResults) {
          await updateReviewStatus(
            t.client,
            42,
            HEAD,
            { state: "in_progress", head: HEAD },
            true,
            "in_progress",
          );
        } else {
          await postRun();
          const posted = JSON.parse(
            await fs.readFile(path.join(directory, "results.json"), "utf8"),
          );
          expect(posted.renderInput.head).toBe(HEAD);
          expect(posted.renderInput.state).toBe("clean");
          if (testCase.postedHead)
            posted.renderInput.head = testCase.postedHead;
          if (testCase.removePostedHead) delete posted.renderInput.head;
          await fs.writeFile(
            path.join(directory, "results.json"),
            JSON.stringify(posted),
          );
        }
        options.head = testCase.liveHead ?? HEAD;
        options.advanceAfterMrFetch = testCase.advanceAfterFetch ?? false;
        if (testCase.trustedHead === null)
          delete process.env.DROID_REVIEW_HEAD_SHA;
        else process.env.DROID_REVIEW_HEAD_SHA = testCase.trustedHead ?? HEAD;
        process.env.CI_COMMIT_SHA = testCase.ciCommitSha ?? HEAD;
        const beforeFinalization = t.requests.length;
        await finishRun();
        const finalRequests = t.requests.slice(beforeFinalization);
        const statuses = finalRequests.filter((r) =>
          r.path.includes("/statuses/"),
        );
        expect(statuses.map((r) => r.path)).toEqual(
          testCase.publishes ? [`/api/v4/projects/42/statuses/${HEAD}`] : [],
        );
        if (testCase.publishes) {
          expect(statuses[0]?.body.state).toBe("success");
          expect(statuses[0]?.body.description).toBe(
            testCase.missingResults ? "Review failed" : "No issues found",
          );
        }
        if (testCase.advanceAfterFetch) expect(options.head).toBe(FIX);
        expect(
          finalRequests.some(
            (r) => r.method === "DELETE" && r.path.endsWith("/award_emoji/3"),
          ),
        ).toBe(true);
        const completed = finalRequests.filter((r) => r.method === "PUT").at(-1)
          ?.body.body;
        expect(typeof completed).toBe("string");
        if (testCase.missingResults)
          expect(completed).toContain(
            "Review did not produce validated results",
          );
      });
    });

  for (const mode of ["legacy", "nonreview", "nostate"])
    it(`finalizer status head: preserves ${mode} early-exit behavior without a binding`, async () => {
      const t = setup({ noState: true });
      await environment(async (directory) => {
        if (mode !== "nostate")
          await fs.writeFile(
            path.join(directory, "state.json"),
            JSON.stringify({
              shouldRunReview: mode !== "nonreview",
              projectId: "42",
              mrIid: 7,
              trackingNoteId: 1,
            }),
          );
        if (mode === "legacy") delete process.env.REVIEW_UX_V2;
        await finishRun();
        expect(
          t.requests.filter((r) => r.path.includes("/statuses/")),
        ).toHaveLength(0);
        expect(t.requests.filter((r) => r.method === "PUT")).toHaveLength(
          mode === "legacy" ? 1 : 0,
        );
      });
    });

  it("fails closed on a validated SHA different from the live MR head", async () => {
    const t = setup({ noState: true });
    await environment(async (directory) => {
      await fs.writeFile(
        path.join(directory, "state.json"),
        JSON.stringify({
          shouldRunReview: true,
          projectId: "42",
          mrIid: 7,
          reviewConfig: config(),
          validatedPath: path.join(directory, "validated.json"),
        }),
      );
      await fs.writeFile(
        path.join(directory, "validated.json"),
        JSON.stringify({ meta: { headSha: BASE }, results: [] }),
      );
      await expect(postRun()).rejects.toThrow("head changed");
      expect(t.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    });
  });

  for (const scenario of [
    "reported",
    "legacy",
    "unbound",
    "mismatch",
    "fixed-meta",
    "ordinary",
  ])
    it(`security scan consumer preserves original source and remediation: ${scenario}`, async () => {
      const t = setup({ noState: true, command: "@droid security --full" });
      await environment(async (directory) => {
        process.env.DROID_SECURITY_FULL =
          scenario === "ordinary" ? "false" : "true";
        process.env.DROID_TRIGGER_NOTE_ID = "20";
        process.env.DROID_REVIEW_HEAD_SHA = HEAD;
        process.env.CI_COMMIT_SHA = FIX;
        if (scenario === "unbound") delete process.env.DROID_REVIEW_HEAD_SHA;
        await fs.writeFile(
          path.join(directory, "state.json"),
          JSON.stringify({
            shouldRunReview: true,
            projectId: "42",
            mrIid: 7,
            reviewConfig: config(),
            validatedPath: path.join(directory, "validated.json"),
          }),
        );
        const scanFinding = {
          ...finding,
          id: "scan-patched",
          security: true,
          securitySeverity: "high",
          path: "src/original-evidence.ts",
          line: 4,
          outside_diff: true,
        };
        await fs.writeFile(
          path.join(directory, "validated.json"),
          JSON.stringify({
            meta: { headSha: scenario === "fixed-meta" ? FIX : HEAD },
            results: [
              { status: "approved", comment: scanFinding },
              {
                status: "approved",
                comment: { ...scanFinding, id: "scan-manual" },
              },
            ],
            ...(scenario === "legacy"
              ? {}
              : {
                  securityReport: {
                    sourceRevision: ["mismatch", "ordinary"].includes(scenario)
                      ? BASE
                      : HEAD,
                    outcomes: [
                      {
                        id: "scan-patched",
                        disposition: "patched",
                        fixCommit: FIX,
                        verification: "Controlled regression passed",
                      },
                      { id: "scan-manual", disposition: "manual" },
                    ],
                  },
                }),
          }),
        );
        if (["mismatch", "fixed-meta"].includes(scenario)) {
          await expect(postRun()).rejects.toThrow(
            scenario === "mismatch"
              ? "pre-model scan revision"
              : /MR head changed after validation|original scan revision/,
          );
          expect(
            t.requests.filter(
              (r) =>
                r.method === "POST" && r.path.endsWith("/repository/commits"),
            ),
          ).toHaveLength(0);
          return;
        }
        await postRun();
        const commits = t.requests.filter(
          (r) => r.method === "POST" && r.path.endsWith("/repository/commits"),
        );
        if (scenario === "ordinary") {
          expect(commits).toHaveLength(0);
          return;
        }
        expect(commits).toHaveLength(1);
        const report = Buffer.from(
          commits[0]!.body.actions[0].content,
          "base64",
        ).toString("utf8");
        expect(report).toContain(`/-/blob/${HEAD}/src/original-evidence.ts#L4`);
        expect(report).not.toContain(`/-/blob/${FIX}/`);
        expect(report).toContain(
          scenario === "unbound"
            ? "reported revision, not independently bound"
            : "recorded before patching",
        );
        if (scenario === "legacy") {
          expect(report).toContain("Remediation status not reported");
          expect(report).not.toContain("Reported patched");
        } else {
          expect(report).toContain("Reported patched");
          expect(report).toContain("not independently verified");
          expect(report).toContain("Controlled regression passed");
          expect(report).toContain("Manual remediation required");
        }
      });
    });

  it("reports effective security blocking flags and all configured-filter drop reasons", async () => {
    const t = setup({
      noState: true,
      yaml: "review_severity_threshold: P1\nsecurity_severity_threshold: high\nshow_dropped_findings: true\nsecurity_block_on_critical: false\nsecurity_block_on_high: true",
    });
    await environment(async (directory) => {
      await fs.writeFile(
        path.join(directory, "state.json"),
        JSON.stringify({
          shouldRunReview: true,
          projectId: "42",
          mrIid: 7,
          trackingNoteId: 1,
          reviewConfig: config(),
          validatedPath: path.join(directory, "validated.json"),
        }),
      );
      const candidates = [
        finding,
        { ...finding, id: "ignored", path: "package-lock.json" },
        { ...finding, id: "priority", severity: "P2" },
        {
          ...finding,
          id: "low-security",
          security: true,
          securitySeverity: "low",
        },
      ];
      await fs.writeFile(
        path.join(directory, "validated.json"),
        JSON.stringify({
          meta: { headSha: HEAD },
          results: candidates.map((comment) => ({
            status: "approved",
            comment,
          })),
        }),
      );
      await postRun();
      const result = JSON.parse(
        await fs.readFile(path.join(directory, "results.json"), "utf8"),
      );
      expect(result.renderInput.summary.security).toMatchObject({
        enabled: true,
        blockOnCritical: false,
        blockOnHigh: true,
        threshold: "high",
      });
      expect(result.renderInput.dropped).toHaveLength(3);
      expect(
        result.renderInput.dropped.map((f: { reason: string }) => f.reason),
      ).toEqual([
        expect.stringContaining("Ignored path"),
        expect.stringContaining("priority threshold P1"),
        expect.stringContaining("security threshold high"),
      ]);
      expect(renderGitlabSummary(result.renderInput)).toContain(
        "4 considered → 1 posted · 3 dropped",
      );
      expect(result.renderInput.factoryFix).toMatchObject({
        reviewUrl: `${mr.web_url}#note_1`,
        head: HEAD,
      });
      result.renderInput.factoryFix.reviewUrl =
        "https://gitlab.com/other/repo/-/merge_requests/99#note_999";
      await fs.writeFile(
        path.join(directory, "results.json"),
        JSON.stringify(result),
      );
      process.env.DROID_REVIEW_HEAD_SHA = HEAD;
      await finishRun();
      const finalized = t.requests
        .filter(
          (request) =>
            request.method === "PUT" && request.path.endsWith("/notes/1"),
        )
        .at(-1)?.body.body;
      const raw = /\[Fix in Factory\]\(([^)]+)\)/.exec(finalized)?.[1];
      expect(raw).toBeDefined();
      const task = new URL(raw!).searchParams.get("prompt")!;
      expect(task).toContain("gitlab.com/group/repo/-/merge_requests/7#note_1");
      expect(task).toContain(HEAD);
      expect(task).not.toContain("/other/repo/");
      expect(task).not.toMatch(/:\/\/|\\/);
      delete process.env.DROID_REVIEW_HEAD_SHA;
      await finishRun();
      expect(
        t.requests
          .filter(
            (request) =>
              request.method === "PUT" && request.path.endsWith("/notes/1"),
          )
          .at(-1)?.body.body,
      ).not.toContain("[Fix in Factory]");
      process.env.DROID_REVIEW_HEAD_SHA = BASE;
      await finishRun();
      expect(
        t.requests
          .filter(
            (request) =>
              request.method === "PUT" && request.path.endsWith("/notes/1"),
          )
          .at(-1)?.body.body,
      ).not.toContain("[Fix in Factory]");
      process.env.DROID_REVIEW_HEAD_SHA = HEAD;
      t.notes.splice(0, 1);
      await finishRun();
      expect(
        t.requests
          .filter(
            (request) =>
              request.method === "POST" && request.path.endsWith("/notes"),
          )
          .at(-1)?.body.body,
      ).not.toContain("[Fix in Factory]");
      expect(
        t.requests.filter(
          (r) => r.method === "POST" && r.path.endsWith("/discussions"),
        ),
      ).toHaveLength(1);
    });
  });

  it("links a LEFT-side renamed finding to its old path at the immutable base SHA", async () => {
    const t = setup({ noState: true });
    await environment(async (directory) => {
      await fs.writeFile(
        path.join(directory, "state.json"),
        JSON.stringify({
          shouldRunReview: true,
          projectId: "42",
          mrIid: 7,
          reviewConfig: config(),
          validatedPath: path.join(directory, "validated.json"),
        }),
      );
      await fs.writeFile(
        path.join(directory, "validated.json"),
        JSON.stringify({
          meta: { headSha: HEAD },
          results: [
            {
              status: "approved",
              comment: { ...finding, side: "LEFT", oldPath: "src/before.ts" },
            },
          ],
        }),
      );
      await postRun();
      const result = JSON.parse(
        await fs.readFile(path.join(directory, "results.json"), "utf8"),
      );
      const body = renderGitlabSummary(result.renderInput);
      expect(
        t.requests.some(
          (r) => r.method === "POST" && r.path.endsWith("/discussions"),
        ),
      ).toBe(true);
      expect(body).toContain(`/-/blob/${BASE}/src/before.ts#L10`);
      expect(body).not.toContain(`/-/blob/${HEAD}/src/before.ts`);
    });
  });

  for (const humanResolved of [false, true])
    it(`orphan recovery retains omitted owned findings, resolved=${humanResolved}`, async () => {
      const t = setup({
        noState: true,
        existingDiscussions: true,
        humanResolved,
        yaml: "fail_on_severity: P1",
      });
      if (humanResolved)
        t.discussion.notes[0]!.body = encodeFindingMarker({
          id: finding.id,
          sev: "P1",
        });
      await environment(async (directory) => {
        await fs.writeFile(
          path.join(directory, "state.json"),
          JSON.stringify({
            shouldRunReview: true,
            projectId: "42",
            mrIid: 7,
            reviewConfig: config(),
            validatedPath: path.join(directory, "validated.json"),
          }),
        );
        await fs.writeFile(
          path.join(directory, "validated.json"),
          JSON.stringify({
            meta: { headSha: HEAD },
            results: [],
          }),
        );
        await postRun();
        const result = JSON.parse(
          await fs.readFile(path.join(directory, "results.json"), "utf8"),
        );
        expect(result.renderInput.reviewState.findings).toHaveLength(1);
        expect(result.renderInput.reviewState.findings[0].id).toBe(finding.id);
        expect(result.renderInput.reviewState.findings[0].threadId).toBe(
          "discussion-1",
        );
        expect(result.renderInput.reviewState.findings[0].state).toBe(
          humanResolved ? "dismissed" : "open",
        );
        expect(result.renderInput.blocked).toBe(!humanResolved);
        expect(
          t.requests.filter(
            (r) => r.method === "POST" && r.path.endsWith("/discussions"),
          ),
        ).toHaveLength(0);
      });
    });

  for (const [disabled, humanResolved, revalidated] of [
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ])
    it(`historical orphan classification disabled=${disabled} resolved=${humanResolved} revalidated=${revalidated}`, async () => {
      const t = setup({
        noState: true,
        existingDiscussions: true,
        humanResolved,
        yaml: disabled
          ? "security_block_on_critical: false\nsecurity_block_on_high: false"
          : "",
      });
      t.discussion.notes[0]!.body = encodeFindingMarker({
        id: finding.id,
        sev: "P2",
        cat: "security",
        head: BASE,
      });
      await environment(async (directory) => {
        await fs.writeFile(
          path.join(directory, "state.json"),
          JSON.stringify({
            shouldRunReview: true,
            projectId: "42",
            mrIid: 7,
            reviewConfig: config(),
            validatedPath: path.join(directory, "validated.json"),
          }),
        );
        await fs.writeFile(
          path.join(directory, "validated.json"),
          JSON.stringify({
            meta: { headSha: HEAD },
            results: revalidated
              ? [{ status: "approved", comment: finding }]
              : [],
          }),
        );
        await postRun();
        const result = JSON.parse(
          await fs.readFile(path.join(directory, "results.json"), "utf8"),
        );
        const recovered = result.renderInput.reviewState.findings[0].finding;
        expect(result.renderInput.blocked).toBe(
          !disabled && !humanResolved && !revalidated,
        );
        expect(recovered.category).toBe(
          revalidated ? finding.category : "recovered-unclassified",
        );
        expect(recovered.securitySeverity).toBeUndefined();
        if (!revalidated) {
          expect(recovered.title).toContain("classification unavailable");
          expect(recovered.verification).toContain("Revalidate");
        }
        expect(result.renderInput.state).toBe(
          humanResolved ? "clean" : "findings",
        );
      });
    });

  for (const owner of [1, 5])
    it(`orphan recovery trusts canonical security state only from owner=${owner}`, async () => {
      const t = setup({ noState: true, existingDiscussions: true });
      t.discussion.notes[0]!.author = { id: owner, username: "fixture" };
      t.discussion.notes[0]!.body = `${encodeFindingMarker({ id: finding.id, sev: "P1", head: BASE })}\n${encodeReviewState(
        {
          head: BASE,
          findings: [
            stateFinding({
              ...finding,
              security: true,
              securitySeverity: "critical",
            }),
          ],
        },
      )}`;
      await environment(async (directory) => {
        await fs.writeFile(
          path.join(directory, "state.json"),
          JSON.stringify({
            shouldRunReview: true,
            projectId: "42",
            mrIid: 7,
            reviewConfig: config(),
            validatedPath: path.join(directory, "validated.json"),
          }),
        );
        await fs.writeFile(
          path.join(directory, "validated.json"),
          JSON.stringify({ meta: { headSha: HEAD }, results: [] }),
        );
        await postRun();
        const result = JSON.parse(
          await fs.readFile(path.join(directory, "results.json"), "utf8"),
        );
        expect(result.renderInput.reviewState.findings).toHaveLength(
          owner === 1 ? 1 : 0,
        );
        expect(result.renderInput.blocked).toBe(owner === 1);
        if (owner === 1)
          expect(
            result.renderInput.reviewState.findings[0].finding.securitySeverity,
          ).toBe("critical");
      });
    });

  for (const context of ["Large verified context. ", "已验证 🛡️ 安全上下文。"])
    it(`inline recovery metadata stays bounded and never becomes a summary note: ${context}`, async () => {
      const t = setup({ noState: true });
      await environment(async (directory) => {
        await fs.writeFile(
          path.join(directory, "state.json"),
          JSON.stringify({
            shouldRunReview: true,
            projectId: "42",
            mrIid: 7,
            reviewConfig: config(),
            validatedPath: path.join(directory, "validated.json"),
          }),
        );
        await fs.writeFile(
          path.join(directory, "validated.json"),
          JSON.stringify({
            meta: { headSha: HEAD },
            results: [
              {
                status: "approved",
                comment: {
                  ...finding,
                  security: true,
                  securitySeverity: "critical",
                  body: context.repeat(6000),
                },
              },
            ],
          }),
        );
        await postRun();
        const body = t.requests.find(
          (r) => r.method === "POST" && r.path.endsWith("/discussions"),
        )!.body.body;
        expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(30 * 1024);
        expect(body.split("\n").includes(SUMMARY_MARKER)).toBe(false);
        expect(decodeReviewState(body)?.head).toBe(HEAD);
        expect(decodeReviewState(body)?.findings).toHaveLength(1);
        expect(decodeReviewState(body)?.findings[0]?.id).toBe(finding.id);
        expect(
          decodeReviewState(body)?.findings[0]?.finding?.securitySeverity,
        ).toBe("critical");
      });
    });

  for (const fullReview of [true, false])
    it(`full metadata preserves the requested review scope, full=${fullReview}`, async () => {
      setup({ yaml: fullReview ? "" : "review_incremental: false" });
      await environment(async (directory) => {
        await fs.writeFile(
          path.join(directory, "state.json"),
          JSON.stringify({
            shouldRunReview: true,
            projectId: "42",
            mrIid: 7,
            fullReview,
            reviewConfig: config(),
            validatedPath: path.join(directory, "validated.json"),
          }),
        );
        // API full diff and incremental comparison deliberately name different files.
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input, init) => {
          const response = await originalFetch(input, init);
          if (String(input).includes("/changes"))
            return json({
              changes: [
                {
                  old_path: "src/x.ts",
                  new_path: "src/x.ts",
                  diff: "@@ -10 +10 @@\n-old\n+new\n",
                },
                {
                  old_path: "src/y.ts",
                  new_path: "src/y.ts",
                  diff: "@@ -1 +1 @@\n-old\n+new\n",
                },
              ],
              diff_refs: mr.diff_refs,
            });
          return response;
        }) as typeof fetch;
        try {
          await fs.writeFile(
            path.join(directory, "validated.json"),
            JSON.stringify({ meta: { headSha: HEAD }, results: [] }),
          );
          await postRun();
          const result = JSON.parse(
            await fs.readFile(path.join(directory, "results.json"), "utf8"),
          );
          expect(result.renderInput.summary.filesReviewed).toBe(2);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    });

  it("LEFT links keep the true MR base after a previous reviewed head", async () => {
    setup({ priorHead: FIX });
    await environment(async (directory) => {
      await fs.writeFile(
        path.join(directory, "state.json"),
        JSON.stringify({
          shouldRunReview: true,
          projectId: "42",
          mrIid: 7,
          reviewConfig: config(),
          validatedPath: path.join(directory, "validated.json"),
        }),
      );
      await fs.writeFile(
        path.join(directory, "validated.json"),
        JSON.stringify({
          meta: { headSha: HEAD },
          results: [
            {
              status: "approved",
              comment: {
                ...finding,
                id: "new-left",
                side: "LEFT",
                oldPath: "src/before.ts",
              },
            },
          ],
        }),
      );
      await postRun();
      const result = JSON.parse(
        await fs.readFile(path.join(directory, "results.json"), "utf8"),
      );
      const body = renderGitlabSummary(result.renderInput);
      expect(body).toContain(`/-/blob/${BASE}/src/before.ts#L10`);
      expect(body).not.toContain(`/-/blob/${FIX}/src/before.ts`);
    });
  });

  it("recovers owned posted findings after an interrupted summary write, without reposting", async () => {
    const t = setup({ noState: true, existingDiscussions: true });
    await environment(async (directory) => {
      await fs.writeFile(
        path.join(directory, "state.json"),
        JSON.stringify({
          shouldRunReview: true,
          projectId: "42",
          mrIid: 7,
          reviewConfig: config(),
          validatedPath: path.join(directory, "validated.json"),
        }),
      );
      await fs.writeFile(
        path.join(directory, "validated.json"),
        JSON.stringify({
          meta: { headSha: HEAD },
          results: [{ status: "approved", comment: finding }],
        }),
      );
      await postRun();
      expect(
        t.requests.filter(
          (r) => r.method === "POST" && r.path.endsWith("/discussions"),
        ),
      ).toHaveLength(0);
      const results = JSON.parse(
        await fs.readFile(path.join(directory, "results.json"), "utf8"),
      );
      expect(results.renderInput.findings[0].threadUrl).toBe(
        `${mr.web_url}#note_10`,
      );
    });
  });

  it("compacts oversized off-mode state and updates one owned hidden note without comment spam", async () => {
    const t = setup({ noState: true, yaml: "review_summary: off" });
    await environment(async (directory) => {
      await fs.writeFile(
        path.join(directory, "state.json"),
        JSON.stringify({
          shouldRunReview: true,
          projectId: "42",
          mrIid: 7,
          trackingNoteId: 1,
          reviewConfig: config(),
          validatedPath: path.join(directory, "validated.json"),
        }),
      );
      await fs.writeFile(
        path.join(directory, "validated.json"),
        JSON.stringify({
          meta: { headSha: HEAD },
          results: [
            {
              status: "approved",
              comment: {
                ...finding,
                body: "Oversized context. ".repeat(10_000),
              },
            },
          ],
        }),
      );
      await postRun();
      await finishRun();
      await finishRun();
      const updates = t.requests.filter(
        (r) => r.method === "PUT" && r.path.endsWith("/notes/1"),
      );
      expect(updates).toHaveLength(2);
      const body = updates[0]?.body.body;
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(60 * 1024);
      expect(decodeReviewState(body)?.findings[0]?.id).toBe(finding.id);
      expect(body).not.toContain("<sub>");
      expect(body).not.toContain("Some optional review context");
      expect(
        t.requests.filter(
          (r) => r.method === "POST" && r.path.endsWith("/notes"),
        ),
      ).toHaveLength(0);
    });
  });
});

describe("GitLab full security report, API mocked", () => {
  it("reuses a completed same-note report and records the command receipt", async () => {
    const t = setup({ command: "@droid security --full" });
    const input = { state: "clean" as const, head: HEAD };
    const first = await publishGitlabSecurityReport(
      t.client,
      42,
      mr,
      20,
      input,
    );
    const second = await publishGitlabSecurityReport(
      t.client,
      42,
      mr,
      20,
      input,
    );
    expect(second).toBe(first);
    expect(
      t.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith("/repository/commits"),
      ),
    ).toHaveLength(1);
    expect(
      t.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith("/merge_requests"),
      ),
    ).toHaveLength(1);
    expect(
      t.notes.some(
        (n) =>
          n.author.id === 1 &&
          n.body.split("\n").includes("<!-- droid-command:v1 note=20 -->"),
      ),
    ).toBe(true);
  });

  it("does not republish after an interrupted report MR creation", async () => {
    const t = setup({ command: "@droid security --full" });
    const input = { state: "clean" as const, head: HEAD };
    const createMr = t.client.createMr.bind(t.client);
    t.client.createMr = async () => {
      throw new Error("controlled interrupted publication");
    };
    await expect(
      publishGitlabSecurityReport(t.client, 42, mr, 20, input),
    ).rejects.toThrow("controlled");
    t.client.createMr = createMr;
    await expect(
      publishGitlabSecurityReport(t.client, 42, mr, 20, input),
    ).rejects.toThrow("already started");
    expect(
      t.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith("/repository/commits"),
      ),
    ).toHaveLength(1);
  });

  it("does not accept another author's forged report receipt", async () => {
    const t = setup({ command: "@droid security --full" });
    t.notes.push(
      note(
        55,
        '<!-- droid-security-report:v1 note=20 -->\n{"status":"complete","url":"https://example.test/fake"}',
        5,
      ),
    );
    await publishGitlabSecurityReport(t.client, 42, mr, 20, {
      state: "clean",
      head: HEAD,
    });
    expect(
      t.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith("/repository/commits"),
      ),
    ).toHaveLength(1);
  });

  it("requires an explicit command then creates an indexed report MR from the reviewed head", async () => {
    const t = setup({ command: "@droid security --full" });
    const url = await publishGitlabSecurityReport(t.client, 42, mr, 20, {
      state: "findings",
      head: HEAD,
      findings: [{ ...finding, security: true, cwe: "CWE-79" }],
    });
    const commit = t.requests.find((r) =>
      r.path.endsWith("/repository/commits"),
    );
    expect(commit?.body.start_sha).toBe(HEAD);
    expect(commit?.body.branch).toStartWith("droid/security-7-");
    const report = Buffer.from(
      commit?.body.actions[0].content,
      "base64",
    ).toString("utf8");
    expect(report).toContain("Findings index");
    expect(report).toContain("How to verify");
    expect(url).toBe("https://gitlab.com/group/repo/-/merge_requests/8");
  });

  it("will not create a full-report MR from an ordinary review command", async () => {
    const t = setup({ command: "@droid review" });
    await expect(
      publishGitlabSecurityReport(t.client, 42, mr, 20, {
        state: "clean",
        head: HEAD,
      }),
    ).rejects.toThrow("explicit");
    expect(t.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
});
