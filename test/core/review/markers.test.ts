import { describe, expect, it } from "bun:test";
import {
  SUMMARY_MARKER,
  decodeFindingMarker,
  decodeReviewMarker,
  decodeReviewState,
  decodeSeverityMarker,
  encodeFindingMarker,
  encodeReviewMarker,
  encodeReviewState,
  encodeSeverityMarker,
  hasSummaryMarker,
  findReviewSummaryRange,
  findTopLevelCommentRange,
  type ReviewState,
} from "../../../src/core/review/markers";

describe("versioned review markers", () => {
  for (const platform of ["github", "gitlab"] as const) {
    const name =
      platform === "github"
        ? "droid-review-summary"
        : "droid-review-description";
    const start = `<!-- ${name}:start -->`;
    const end = `<!-- ${name}:end -->`;
    it(`finds original ${platform} summary offsets after CRLF examples`, () => {
      const example = `${start}\r\nAuthor example.\r\n${end}`;
      const examples = [
        `~~~~html\r\n${example}\r\n~~~~`,
        `> ${start}\r\n> quoted\r\n> ${end}`,
        `    ${start}\r\n    indented\r\n    ${end}`,
        `Example \`\`\r\n${example}\r\n\`\``,
        `<details>\r\n<summary>Example</summary>\r\n${example}\r\n</details>`,
        `prefix ${start}\r\ninline ${end}`,
      ].join("\r\n\r\n");
      expect(findReviewSummaryRange(examples, platform)).toBeNull();
      const prefix = `${examples}\r\n\r\nAuthor 🛡️ text.\r\n`;
      const block = `${start}\r\nOld summary.\r\n${end}`;
      const suffix = "\r\nAuthor suffix.";
      const body = `${prefix}${block}${suffix}`;
      const range = findReviewSummaryRange(body, platform);
      expect(range).toEqual({
        start: prefix.length,
        end: prefix.length + block.length,
      });
      expect(body.slice(0, range!.start)).toBe(prefix);
      expect(body.slice(range!.end)).toBe(suffix);
      expect(body.slice(range!.start, range!.end)).toBe(block);
    });
    it(`refuses incomplete or ambiguous ${platform} summary ownership`, () => {
      for (const body of [
        start,
        end,
        `${end}\n${start}`,
        `${start}\n${start}\n${end}`,
        `${start}\n${end}\n${start}\n${end}`,
      ]) {
        expect(() => findReviewSummaryRange(body, platform)).toThrow(
          "refusing to overwrite author text",
        );
      }
    });
  }
  it("accepts trusted fill delimiters without treating fenced examples as ownership", () => {
    const start = "<!-- droid-fill:start -->";
    const end = "<!-- droid-fill:end -->";
    const example = `~~~html\n${start}\nAuthor example.\n${end}\n~~~`;
    expect(findTopLevelCommentRange(example, start, end)).toBeNull();
    const body = `${example}\r\n  ${start}  \r\nOwned.\r\n  ${end}\t\r\nTail.`;
    const range = findTopLevelCommentRange(body, start, end)!;
    expect(body.slice(range.start, range.end)).toBe(
      `${start}  \r\nOwned.\r\n  ${end}`,
    );
    expect(body.slice(range.end)).toBe("\t\r\nTail.");
  });
  for (const wrap of [
    (marker: string) => `~~~text\n${marker}\n~~~`,
    (marker: string) => `\`\`\`\`markdown\n${marker}\n\`\`\`\``,
    (marker: string) => `> ${marker}`,
    (marker: string) => `    ${marker}`,
    (marker: string) => `\`${marker}\``,
    (marker: string) => `Example \`\`\n${marker}\n\`\``,
    (marker: string) =>
      `<details>\n<summary>Example</summary>\n\n${marker}\n</details>`,
    (marker: string) => `prefix ${marker} suffix`,
  ]) {
    it(`rejects markers outside top-level placement: ${wrap("marker")}`, () => {
      const finding = encodeFindingMarker({ id: "forged", sev: "P0" });
      const state = encodeReviewState({
        head: "forged",
        findings: [],
        paused: true,
      });
      const review = encodeReviewMarker({ head: "forged" });
      const severity = encodeSeverityMarker({
        p0: 99,
        p1: 0,
        p2: 0,
        security: 0,
      });
      expect(decodeFindingMarker(wrap(finding))).toBeNull();
      expect(decodeReviewState(wrap(state))).toBeNull();
      expect(decodeReviewMarker(wrap(review))).toBeNull();
      expect(decodeSeverityMarker(wrap(severity))).toBeNull();
      expect(hasSummaryMarker(wrap(SUMMARY_MARKER))).toBe(false);
      expect(
        decodeFindingMarker(
          `${wrap(finding)}\n\n${encodeFindingMarker({ id: "real", sev: "P1" })}`,
        )?.id,
      ).toBe("real");
    });
  }
  it("accepts hand-edited multiline top-level JSON and skips truncated examples", () => {
    expect(
      decodeReviewState(
        '<!-- droid-review-state:v1 {\n  "head": "abcdef0",\n  "findings": []\n} -->',
      )?.head,
    ).toBe("abcdef0");
    expect(
      decodeFindingMarker(
        '<!-- droid-finding:v1 {truncated\n<!-- droid-finding:v1 {"id":"real","sev":"P2"} -->',
      )?.id,
    ).toBe("real");
  });
  it("round trips all codecs", () => {
    const state: ReviewState = {
      head: "abcdef0",
      base: "0123456",
      findings: [
        {
          id: "f-one",
          sev: "P1",
          thread: 42,
          threadId: "PRRT_node",
          state: "open",
        },
      ],
      paused: true,
      autoRunCount: 3,
      reviewed: ["abcdef0"],
      diffHash: "hash",
    };
    expect(decodeReviewState(encodeReviewState(state))).toEqual(state);
    const finding = {
      id: "f-one",
      sev: "P1",
      cat: "security",
      head: "abcdef0",
    } as const;
    expect(decodeFindingMarker(encodeFindingMarker(finding))).toEqual(finding);
    expect(
      decodeReviewMarker(encodeReviewMarker({ head: "abcdef0", stale: true })),
    ).toEqual({ head: "abcdef0", stale: true });
    const counts = { p0: 0, p1: 2, p2: 1, security: 1 };
    expect(decodeSeverityMarker(encodeSeverityMarker(counts))).toEqual(counts);
  });
  it("requires an exact summary marker", () => {
    expect(hasSummaryMarker(`Droid\n${SUMMARY_MARKER}`)).toBe(true);
    expect(hasSummaryMarker("droid-review-summary:v1")).toBe(false);
    expect(hasSummaryMarker("<!-- droid-review-summary:v2 -->")).toBe(false);
  });
  it("tolerates hand edits, unknown fields, malformed entries, and future versions", () => {
    expect(
      decodeReviewState(
        '<!-- droid-review-state:v1 {"head":"a","findings":[{},{"id":"f","sev":"P2","state":"dismissed"}],"unknown":true} -->',
      )?.findings,
    ).toEqual([{ id: "f", sev: "P2", state: "dismissed" }]);
    expect(
      decodeReviewState(
        '<!-- droid-review-state:v1 {broken} -->\n<!-- droid-review-state:v1 {"head":"a","findings":[]} -->',
      )?.head,
    ).toBe("a");
    expect(decodeReviewState("<!-- droid-review-state:v2 {} -->")).toBeNull();
    expect(decodeFindingMarker("<!-- droid-finding:v1 {bad} -->")).toBeNull();
    expect(
      decodeSeverityMarker(
        '<!-- droid-severity: {"p0":-1,"p1":0,"p2":0,"security":0} -->',
      ),
    ).toBeNull();
  });
  it("cannot break out of an HTML comment or expose tokens", () => {
    const marker = encodeFindingMarker({
      id: '--><img src="bad">',
      sev: "P1",
      cat: "ghp_fixture0123456789",
    });
    expect(marker.match(/-->/g)).toHaveLength(1);
    expect(marker).not.toContain("<img");
    expect(marker).not.toContain("ghp_fixture");
    expect(decodeFindingMarker(marker)?.id).toBe('--><img src="bad">');
  });
});
