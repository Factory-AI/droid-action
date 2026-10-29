import { afterEach, describe, expect, it, mock } from "bun:test";
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
    if (url.pathname.endsWith("/notes") && req.method === "POST")
      return json(note(99, "response"));
    if (url.pathname.endsWith("/notes/1") && req.method === "PUT")
      return json(note(1, "updated"));
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
      const currentMr = {
        ...mr,
        draft: options.draft ?? false,
        diff_refs: { ...mr.diff_refs, head_sha: options.head ?? HEAD },
      };
      if (options.advanceAfterMrFetch) options.head = FIX;
      return json(currentMr);
    }
    if (url.pathname.endsWith("/merge_requests") && req.method === "POST")
      return json({ ...mr, web_url: mr.web_url + "-stacked" });
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
    expect(posted?.body.body).toContain('alt="P1"');
    expect(posted?.body.body).toContain("Why this was flagged");
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
    t.client.listAwards = listAwards;
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
      projectId: 42,
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
      "DROID_SECURITY_FULL",
      "DROID_SECURITY_ONLY",
      "DROID_REVIEW_HEAD_SHA",
      "DROID_LIFECYCLE_AWARD_CONTEXT",
      "DROID_TRIGGER_NOTE_ID",
      "AUTOMATIC_REVIEW",
      "AUTOMATIC_SECURITY_REVIEW",
      "REVIEW_DEPTH",
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
      HOME: directory,
      DROID_PASS1_LOG: path.join(directory, "missing1.jsonl"),
      DROID_PASS2_LOG: path.join(directory, "missing2.jsonl"),
    });
    try {
      await test(directory);
    } finally {
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
      expect(prepared.reviewConfig.review_badges).toBe("image");
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
    expect(url).toContain("stacked");
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
