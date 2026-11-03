import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { buildReviewPreviews } from "../../../scripts/preview-review";
import { parseValidatedReview } from "../../../src/core/review/validated/parse";
import { normalizeFinding } from "../../../src/core/review/validated/finding";
import {
  escapeMarkdown,
  fenced,
  pluralize,
  redactSecrets,
  relativeTime,
  renderInlineComment,
  renderReviewSummary,
  safeDiagram,
  safeUrl,
  shortSha,
  validateRenderedMarkdown,
  wrapPath,
} from "../../../src/core/review/render";

const raw = readFileSync(
  new URL("../../fixtures/review-ux/validated.json", import.meta.url),
  "utf8",
);
describe("review render templates", () => {
  for (const [name, body] of Object.entries(buildReviewPreviews(raw))) {
    it(name, () => {
      expect(validateRenderedMarkdown(body)).toEqual([]);
      expect(body).toMatchSnapshot();
      expect(body).not.toContain("sk-fixturesecret123");
      expect(body).not.toContain("👍");
      expect(body).not.toContain("👎");
    });
  }
  it("omits empty sections and counts in a clean review", () => {
    const body = renderReviewSummary({
      state: "clean",
      head: "abcdef0123456",
      candidatesConsidered: 0,
    });
    expect(body).not.toContain("| **Open**");
    expect(body).not.toContain("What changed");
    expect(body).not.toContain("Fix with an agent");
    expect(body).not.toContain("None");
    expect(body).toContain("0 considered");
    expect(body).toContain("🟢 Looks good to merge");
  });
  it("supports diagram/effort-only sections and fully disables diagram output", () => {
    const summary = parseValidatedReview(raw).summary;
    const diagramOnly = renderReviewSummary({
      state: "clean",
      summary,
      sections: ["diagram"],
    });
    expect(diagramOnly).toContain("~~~mermaid");
    expect(diagramOnly).not.toContain("| Area |");
    const effortOnly = renderReviewSummary({
      state: "clean",
      summary,
      sections: ["effort"],
      diagram: "off",
    });
    expect(effortOnly).toContain("Estimated review effort: 3/5");
    expect(effortOnly).not.toContain("~~~mermaid");
    expect(
      renderReviewSummary({ state: "clean", summary, diagram: "off" }),
    ).not.toContain("~~~mermaid");
  });
  it("keeps the last completed review without repeated running banners", () => {
    const completed = renderReviewSummary({ state: "clean", head: "abcdef0" });
    const running = renderReviewSummary({
      state: "in_progress",
      head: "abcdef1",
      previousBody: completed,
      previousHead: "abcdef0",
    });
    const retried = renderReviewSummary({
      state: "in_progress",
      head: "abcdef1",
      previousBody: running,
      previousHead: "abcdef0",
    });
    expect(retried.match(/Droid is reviewing/g)).toHaveLength(1);
    expect(retried.match(/#### Previous review/g)).toHaveLength(1);
    expect(retried.match(/Reviewed by/g)).toHaveLength(1);
    expect(retried).toContain("No issues found");
    expect(validateRenderedMarkdown(retried)).toEqual([]);
  });
  it("reports the highest security level and never calls outside-diff findings clean", () => {
    const finding = parseValidatedReview(raw).findings[1]!;
    const body = renderReviewSummary({
      state: "clean",
      findings: [
        { ...finding, severity: "P2", securitySeverity: "low" },
        { ...finding, id: "critical", securitySeverity: "critical" },
      ],
    });
    expect(body).toContain("Changes recommended");
    expect(body).not.toContain("Looks good to merge");
    expect(body).toContain("2 findings (Critical)");
    expect(body).toContain("Outside the diff (2)");
  });
  it("does not interpret model prose as markup or bot commands", () => {
    const finding = normalizeFinding({
      title: "Bad | [title](javascript:bad)",
      body: "</details><script>bad</script>\n@droid fix",
      path: "src/a|b.ts",
      line: 1,
    });
    const body = renderInlineComment(finding);
    expect(body.split("~~~text")[0]).not.toContain("<script>");
    expect(body.split("~~~text")[0]).not.toContain("</details><script>");
    expect(body).toContain("\\|");
    expect(body).toContain("@\u200bdroid");
    expect(validateRenderedMarkdown(body)).toEqual([]);
  });
  it("allows nested backticks and tilde fences in agent data", () => {
    const body = fenced("```ts\nhello\n```\n~~~~~\nuntrusted\n~~~~~");
    expect(body.startsWith("~~~~~~text")).toBe(true);
    expect(validateRenderedMarkdown(body)).toEqual([]);
  });
  it("omits suggestions for LEFT-side or outside-diff findings", () => {
    const finding = parseValidatedReview(raw).findings[0]!;
    expect(renderInlineComment({ ...finding, side: "LEFT" })).not.toContain(
      "~~~suggestion",
    );
    expect(
      renderInlineComment({ ...finding, outside_diff: true }),
    ).not.toContain("~~~suggestion");
    expect(
      renderInlineComment(finding, { includeAgentPrompts: false }),
    ).not.toContain("Fix with an agent");
  });
  it("renders indentation, trailing newlines, and explicit deletion suggestions", () => {
    const finding = parseValidatedReview(raw).findings[0]!;
    expect(
      renderInlineComment({ ...finding, suggestion: "    return value;\n" }),
    ).toContain("~~~suggestion\n    return value;\n\n~~~");
    expect(renderInlineComment({ ...finding, suggestion: "" })).toContain(
      "~~~suggestion\n\n~~~",
    );
  });
  it("renders GitLab full-SHA permalinks without GitHub anchor syntax", () => {
    const finding = parseValidatedReview(raw).findings[0]!;
    const body = renderReviewSummary({
      state: "findings",
      findings: [finding],
      platform: "gitlab",
      repositoryUrl: "https://gitlab.example.com/group/project",
      head: "9ea6c830123456789abcdef0123456789abcdef012",
    });
    expect(body).toContain(
      "/-/blob/9ea6c830123456789abcdef0123456789abcdef012/src/storage/budgetTracker.ts#L451-465",
    );
    expect(body).not.toContain("#L451-L465");
    expect(body).toContain("Guideline:");
    expect(body).toContain(
      "/-/blob/9ea6c830123456789abcdef0123456789abcdef012/AGENTS.md#L12-18",
    );
    expect(body).toContain(
      "/-/blob/9ea6c830123456789abcdef0123456789abcdef012/src/storage/cacheStore.ts#L27-40",
    );
    expect(body).not.toContain("#L27-L40");
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("https://example.com/path(unsafe)")).toContain(
      "%28unsafe%29",
    );
  });
  for (const platform of ["github", "gitlab"] as const) {
    it(`links renamed and deleted LEFT findings to the base commit (${platform})`, () => {
      const finding = normalizeFinding({
        title: "Removed guard allows unsafe access",
        severity: "P1",
        security: true,
        path: "src/new.ts",
        old_path: "src/deleted.ts",
        side: "LEFT",
        line: 20,
        old_line: 10,
        startLine: 8,
        body: "A verified removed-code issue.",
      });
      const input = {
        state: "findings" as const,
        platform,
        findings: [finding],
        repositoryUrl: "https://example.com/group/repo",
        head: "9ea6c830123456789abcdef0123456789abcdef012",
        base: "1a2b3c40123456789abcdef0123456789abcdef012",
      };
      const body = renderReviewSummary(input);
      const expected = `${platform === "gitlab" ? "/-/blob/" : "/blob/"}${input.base}/src/deleted.ts#L8-${platform === "gitlab" ? "" : "L"}10`;
      expect(body).toContain(expected);
      expect(body).not.toContain(`${input.head}/src/deleted.ts`);
      expect(body).not.toContain("src/new.ts:8-20");
      expect(renderInlineComment(finding, input)).toContain(
        "src/deleted.ts:8-10",
      );
      const withoutBase = renderReviewSummary({ ...input, base: undefined });
      expect(withoutBase).toContain("src/deleted.ts:8-10");
      expect(withoutBase).not.toContain(`/blob/${input.head}/src/deleted.ts`);
    });
  }
});
describe("shared rendering helpers", () => {
  it("pluralizes, shortens SHAs, wraps paths, and validates timestamps", () => {
    expect(pluralize(1, "issue")).toBe("1 issue");
    expect(pluralize(2, "issue")).toBe("2 issues");
    expect(shortSha("abcdef012345")).toBe("abcdef0");
    expect(wrapPath("src/long/path.ts")).toBe("src/\u200blong/\u200bpath.ts");
    expect(relativeTime("not a date")).toBe("");
    expect(relativeTime("2026-10-28T12:00:00Z")).toContain(
      'datetime="2026-10-28T12:00:00.000Z"',
    );
    expect(escapeMarkdown("|[x]<details>")).toContain(
      "\\|\\[x\\]&lt;details&gt;",
    );
  });
  it("redacts errors, credential URLs, bearer tokens, and private keys", () => {
    const input =
      "FACTORY_API_KEY=plain-secret authorization: Bearer token123 https://user:pass@example.com?token=abc ghp_fixture0123456789 -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    const output = redactSecrets(input);
    for (const secret of [
      "plain-secret",
      "token123",
      "user:pass",
      "token=abc",
      "ghp_fixture",
      "\nabc\n",
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED");
  });
  it("reuses known Factory/GitLab patterns, exact environment values, and truncated private keys", () => {
    const factory = `fk-${"a".repeat(25)}`;
    const gitlab = `glpat-${"b".repeat(25)}`;
    const unprefixed = "unprefixed-runtime-credential";
    const appKey = "opaque-app-private-key-value";
    const env = { CI_JOB_TOKEN: unprefixed, APP_PRIVATE_KEY: appKey };
    const output = redactSecrets(
      `${factory} ${gitlab} ${unprefixed} ${appKey}`,
      env,
    );
    for (const secret of [factory, gitlab, unprefixed, appKey])
      expect(output).not.toContain(secret);
    expect(
      redactSecrets(
        "-----BEGIN OPENSSH PRIVATE KEY-----\ntruncated-private-material",
        {},
      ),
    ).not.toContain("truncated-private-material");
    expect(redactSecrets("ordinary review text", {})).toBe(
      "ordinary review text",
    );
    expect(
      safeUrl(`https://example.com/${factory}?token=${gitlab}`),
    ).not.toContain(factory);
    expect(
      safeUrl(`https://example.com/${factory}?token=${gitlab}`),
    ).not.toContain(gitlab);
    const finding = normalizeFinding({
      id: factory,
      title: factory,
      body: gitlab,
      why: factory,
      verification: gitlab,
      agent_prompt: factory,
      category: gitlab,
      path: `src/${factory}.ts`,
      line: 1,
    });
    const body = renderInlineComment(finding, {
      repositoryUrl: "https://example.com/repo",
      head: "abcdef0123456",
    });
    expect(body).not.toContain(factory);
    expect(body).not.toContain(gitlab);
  });
  it("rejects active diagrams and invalid structural markup", () => {
    expect(safeDiagram("flowchart LR\n A-->B")).not.toBeNull();
    expect(safeDiagram('flowchart LR\n click A "https://bad.test"')).toBeNull();
    expect(safeDiagram("%%{init: {}}%%\nflowchart LR")).toBeNull();
    expect(
      validateRenderedMarkdown(
        "<details>\n<summary>Empty</summary>\n</details>",
      ),
    ).toContain("Empty details section");
    expect(validateRenderedMarkdown("~~~text\nunclosed")).toContain(
      "Unbalanced code fence",
    );
    expect(validateRenderedMarkdown("</details>")).toContain(
      "Unmatched closing details tag",
    );
  });
});
