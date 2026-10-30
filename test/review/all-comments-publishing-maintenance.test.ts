import { describe, expect, it, spyOn } from "bun:test";
import {
  decodeFindingMarker,
  decodeReviewState,
  encodeFindingMarker,
  encodeReviewState,
  hasReviewSessionMarker,
  type ReviewState,
} from "../../src/core/review/markers";
import { normalizeFinding } from "../../src/core/review/validated/finding";
import {
  inlineCode,
  redactSecrets,
  renderReviewSummary,
  safeDiagram,
} from "../../src/core/review/render";
import { redactCredentials } from "../../src/utils/redact-credentials";
import {
  listDroidThreads,
  resolveDroidThread,
  stateFindings,
} from "../../src/github/operations/review-lifecycle";
import type { Octokits } from "../../src/github/api/client";
import { optionalGitHubOperation } from "../../src/github/operations/review-checks";

const HEAD = "a".repeat(40);
const finding = () =>
  normalizeFinding({
    id: "canonical",
    title: "Canonical issue",
    severity: "P1",
    path: "src/canonical.ts",
    line: 3,
    body: "Canonical content.",
  });

describe("QA75 publishing maintenance behavior", () => {
  it("5033 preserves permission classification and retry limits with secret-free diagnostics", async () => {
    const errors: string[] = [];
    const log = spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });
    let calls = 0;
    let warnings = 0;
    try {
      await optionalGitHubOperation(
        async () => {
          calls++;
          throw Object.assign(
            new Error("Authorization: Bearer fixture-sensitive"),
            { status: 403 },
          );
        },
        () => {
          warnings++;
        },
      );
      expect(calls).toBe(1);
      expect(warnings).toBe(1);
      expect(errors.join("\n")).not.toContain("fixture-sensitive");
      calls = 0;
      const result = await optionalGitHubOperation(
        async () => {
          if (++calls === 1)
            throw Object.assign(new Error("Transient"), { status: 503 });
          return "recovered";
        },
        () => {
          warnings++;
        },
      );
      expect(result).toBe("recovered");
      expect(calls).toBe(2);
      expect(warnings).toBe(1);
    } finally {
      log.mockRestore();
    }
  });
  for (const literal of ["`<details>`", "``</details>``", "`<DeTaIlS>`"]) {
    it(`2312 keeps literal inline tags from affecting ownership: ${literal}`, () => {
      const marker = encodeFindingMarker({ id: "real", sev: "P1" });
      expect(decodeFindingMarker(`${literal}\n${marker}`)?.id).toBe("real");
    });
  }
  it("2312 ignores a literal close inside a real details wrapper", () => {
    const marker = encodeFindingMarker({ id: "forged", sev: "P0" });
    expect(
      decodeFindingMarker(`<details>\n\`</details>\`\n${marker}\n</details>`),
    ).toBeNull();
    expect(
      decodeFindingMarker(`\`<details>\n</details>\`\n${marker}`)?.id,
    ).toBe("forged");
  });
  for (const tag of ["DETAILS", "DeTaIlS"]) {
    it(`2319 excludes mixed-case ${tag} state/session examples`, () => {
      const session = `<!-- droid-review-active:v1 head=${HEAD} run=123 -->`;
      const state = encodeReviewState({
        head: HEAD,
        paused: true,
        findings: [],
      });
      const wrapped = `<${tag} open>\n${state}\n${session}\n</${tag}>`;
      expect(decodeReviewState(wrapped)).toBeNull();
      expect(hasReviewSessionMarker(wrapped, session)).toBe(false);
      expect(hasReviewSessionMarker(`${wrapped}\n${session}`, session)).toBe(
        true,
      );
    });
  }
  for (const [replacement, expected] of [
    ["", ""],
    ["  ", "  "],
    ["one\ntwo", "one\ntwo"],
    ["one\n", "one\n"],
  ] as const) {
    it(`2341 extracts deletion/replacement ${JSON.stringify(replacement)}`, () => {
      const fence = `\`\`\`suggestion\n${replacement}${replacement ? "\n" : ""}\`\`\``;
      const normalized = normalizeFinding({
        title: "Delete unsafe code",
        path: "src/delete.ts",
        line: 2,
        body: `Before.\n${fence}\nAfter.`,
      });
      expect(normalized.suggestion).toBe(expected);
      expect(normalized.body).toBe("Before.\n\nAfter.");
    });
  }
  it("2346 restores persisted metadata without granting it to model input", () => {
    const stored = {
      ...finding(),
      threadUrl: "https://github.com/o/r/pull/7#discussion_r5",
      threadId: 5,
      state: "resolved" as const,
      isNew: false,
      fixedIn: HEAD,
      pendingThreadAction: "resolve" as const,
      also_at: [
        { path: "src/other.ts", line: 2, url: "https://example.test/other" },
      ],
      source_guideline: { path: "rules.md", url: "https://example.test/rule" },
    };
    const state: ReviewState = {
      head: HEAD,
      findings: [
        {
          id: stored.id,
          sev: stored.severity,
          state: "resolved",
          finding: stored,
        },
      ],
    };
    expect(
      decodeReviewState(encodeReviewState(state))?.findings[0]?.finding,
    ).toEqual(stored);
    const model = normalizeFinding(stored);
    for (const key of [
      "threadUrl",
      "threadId",
      "state",
      "isNew",
      "fixedIn",
      "pendingThreadAction",
    ])
      expect(model).not.toHaveProperty(key);
    expect(model.also_at[0]).not.toHaveProperty("url");
    expect(model.source_guideline).not.toHaveProperty("url");
  });
  it("2380 persists one canonical content representation and reconciles legacy conflicts", () => {
    const canonical = { ...finding(), pendingThreadAction: "reopen" as const };
    const conflicting: ReviewState = {
      head: HEAD,
      findings: [
        {
          id: "stale",
          sev: "P0",
          path: "stale.ts",
          title: "Stale",
          body: "Stale body",
          line: 99,
          state: "dismissed",
          commentId: 8,
          threadId: "NODE",
          finding: canonical,
        },
      ],
    };
    const encoded = encodeReviewState(conflicting);
    const persisted = JSON.parse(
      encoded.slice(encoded.indexOf("{"), encoded.lastIndexOf("}") + 1),
    );
    expect(persisted.findings[0]).not.toHaveProperty("path");
    expect(persisted.findings[0]).not.toHaveProperty("body");
    expect(persisted.findings[0].id).toBe("canonical");
    const legacyConflict = `<!-- droid-review-state:v1 ${JSON.stringify(conflicting)} -->`;
    const decoded = decodeReviewState(legacyConflict)!;
    expect(decoded.findings[0]).toMatchObject({
      id: "canonical",
      sev: "P1",
      path: canonical.path,
      line: 3,
      title: canonical.title,
      body: canonical.body,
      state: "dismissed",
      commentId: 8,
    });
    expect(stateFindings(decoded)[0]).toMatchObject({
      id: "canonical",
      state: "dismissed",
      threadId: "NODE",
      pendingThreadAction: "reopen",
    });
    const legacy = decodeReviewState(
      `<!-- droid-review-state:v1 ${JSON.stringify({
        head: HEAD,
        findings: [
          {
            id: "legacy",
            sev: "P2",
            state: "open",
            path: "old.ts",
            title: "Old",
            body: "Details",
            line: 1,
          },
        ],
      })} -->`,
    )!;
    expect(stateFindings(legacy)[0]).toMatchObject({
      id: "legacy",
      severity: "P2",
      path: "old.ts",
    });
  });
  it("2384 shares short-token, assignment, URL, private-key and injectable-env redaction", () => {
    const text = [
      "ghp_12345678",
      "Authorization: Bearer sensitive",
      "https://reader:password@example.test/x?token=hidden",
      "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----",
      "injected-secret",
    ].join("\n");
    const env = { APP_PRIVATE_KEY: "injected-secret" };
    expect(redactSecrets(text, env)).toBe(redactCredentials(text, env));
    for (const secret of [
      "ghp_12345678",
      "sensitive",
      "reader:password",
      "token=hidden",
      "injected-secret",
    ])
      expect(redactCredentials(text, env)).not.toContain(secret);
    expect(
      redactCredentials("A normal sentence about authentication.", {}),
    ).toBe("A normal sentence about authentication.");
  });
  it("4998 escapes only link-label Markdown while preserving URL encoding and inline code", () => {
    const path = "src/é[link](target)\\name|part.ts";
    const body = renderReviewSummary({
      state: "findings",
      head: HEAD,
      repositoryUrl: "https://github.com/o/r",
      findings: [{ ...finding(), path }],
      includeAgentPrompts: false,
    });
    expect(body).toContain(
      "<code>src/é\\[link\\]\\(target\\)\\\\name&#124;part.ts:3</code>",
    );
    expect(body).toContain(
      "src/%C3%A9%5Blink%5D(target)%5Cname%7Cpart.ts"
        .replaceAll("(", "%28")
        .replaceAll(")", "%29"),
    );
    expect(inlineCode("[literal](text)")).toBe("<code>[literal](text)</code>");
  });
  for (const directive of [
    "click A call callback",
    "linkStyle 0 stroke:red",
    "style A fill:red",
    "classDef danger fill:red",
    "%%{init: {}}%%",
    "<script>bad</script>",
  ]) {
    it(`5007 rejects semicolon-separated active diagram content: ${directive}`, () => {
      expect(safeDiagram(`flowchart TD; A-->B; ${directive}`)).toBeNull();
    });
  }
  it("5007 preserves passive flowchart and sequence diagrams", () => {
    expect(safeDiagram("flowchart TD; A-->B")).toBe("flowchart TD; A-->B");
    expect(safeDiagram("sequenceDiagram\nA->>B: hello")).not.toBeNull();
  });
  for (const trusted of [true, false]) {
    it(`0458/0480/0489 paginates owned replies without adopting an untrusted root (${trusted})`, async () => {
      let commentPages = 0;
      let resolutions = 0;
      let replies = 0;
      const octokit = {
        rest: {
          pulls: {
            createReplyForReviewComment: async () => {
              replies++;
              return { data: { id: 1000 } };
            },
          },
        },
        graphql: async (query: string, input: Record<string, unknown>) => {
          if (query.includes("DroidViewer"))
            return { viewer: { login: "factory-droid[bot]" } };
          if (query.includes("DroidReviewThreadComments")) {
            commentPages++;
            expect(input).toEqual({ id: "THREAD", cursor: "NEXT" });
            return {
              node: {
                comments: {
                  nodes: [
                    {
                      databaseId: 101,
                      body: `✅ Fixed in ${HEAD.slice(0, 7)}.`,
                    },
                    { databaseId: 102, body: "@droid why?" },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            };
          }
          if (query.includes("DroidResolveThread")) {
            if (++resolutions === 1)
              throw new Error("Resolution response lost");
            return { resolveReviewThread: { thread: { isResolved: true } } };
          }
          return {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "THREAD",
                      isResolved: false,
                      path: "src/a.ts",
                      line: 3,
                      comments: {
                        nodes: [
                          {
                            databaseId: 1,
                            body: encodeFindingMarker({
                              id: "known",
                              sev: "P1",
                            }),
                            url: "https://github.com/o/r/pull/7#discussion_r1",
                            author: {
                              login: trusted ? "factory-droid[bot]" : "human",
                              databaseId: trusted ? 138933559 : 5,
                            },
                          },
                          ...Array.from({ length: 99 }, (_, n) => ({
                            databaseId: n + 2,
                            body: "Earlier reply",
                          })),
                        ],
                        pageInfo: { hasNextPage: true, endCursor: "NEXT" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        },
      } as unknown as Octokits;
      const options = { octokit, owner: "o", repo: "r", prNumber: 7 };
      const threads = await listDroidThreads(options);
      if (!trusted) {
        expect(threads).toEqual([]);
        expect(commentPages).toBe(0);
        return;
      }
      const thread = threads[0]!;
      expect(thread.nodeId).toBe("THREAD");
      expect(thread).not.toHaveProperty("id");
      expect(thread.commentId).toBe(1);
      expect(thread.comments.at(-1)).toEqual({ id: 102, body: "@droid why?" });
      expect(thread.comments[0]).not.toHaveProperty("author");
      await expect(
        resolveDroidThread({ ...options, thread, head: HEAD }),
      ).rejects.toThrow("Resolution response lost");
      const fresh = (await listDroidThreads(options))[0]!;
      await resolveDroidThread({ ...options, thread: fresh, head: HEAD });
      expect(replies).toBe(0);
      expect(commentPages).toBe(2);
      expect(fresh.resolved).toBe(true);
    });
  }
});
