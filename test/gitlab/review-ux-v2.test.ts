import { afterEach, describe, expect, it, mock } from "bun:test";
import { GitlabClient } from "../../src/gitlab/api/client";
import {
  encodeFindingMarker,
  encodeReviewState,
  SUMMARY_MARKER,
} from "../../src/core/review/markers";
import { normalizeFinding } from "../../src/core/review/validated/finding";
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
    if (url.pathname.endsWith("/merge_requests/7") && req.method === "GET")
      return json({ ...mr, draft: options.draft ?? false });
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
