import { describe, expect, it } from "bun:test";
import { parseValidatedReview } from "../../../src/core/review/validated/parse";
import { SECURITY_SEVERITY_RANK } from "../../../src/core/review/validated/finding";
const approved = (comment: Record<string, unknown>) => ({
  status: "approved",
  comment,
});
describe("rich validated review schema", () => {
  it("shares the exact publisher security-level ordering without changing priority policy", () => {
    expect(SECURITY_SEVERITY_RANK).toEqual({
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    });
    expect(
      SECURITY_SEVERITY_RANK.critical < SECURITY_SEVERITY_RANK.high &&
        SECURITY_SEVERITY_RANK.high < SECURITY_SEVERITY_RANK.medium &&
        SECURITY_SEVERITY_RANK.medium < SECURITY_SEVERITY_RANK.low,
    ).toBe(true);
  });

  it("parses explicit prior finding resolutions without inventing candidate results", () => {
    const parsed = parseValidatedReview(
      JSON.stringify({
        results: [],
        findingResolutions: [
          {
            id: "fixed",
            status: "fixed",
            evidence: "The current branch restores the missing guard.",
          },
          { id: "unverified", status: "fixed" },
          { id: "open", status: "open", evidence: "The issue remains." },
        ],
      }),
    );
    expect(parsed.fixedFindings.map((finding) => finding.id)).toEqual([
      "fixed",
    ]);
    expect(parsed.approvedCount).toBe(0);
    expect(parsed.rejectedCount).toBe(0);
  });
  it("retains explicit optional classifications without inferring optionality from P2", () => {
    const parse = (optionalSuggestion?: boolean) =>
      parseValidatedReview(
        JSON.stringify({
          results: [
            approved({
              title: "A verified issue",
              severity: "P2",
              body: "A verified issue.",
              path: "a.ts",
              line: 1,
              ...(optionalSuggestion !== undefined
                ? { optionalSuggestion }
                : {}),
            }),
          ],
        }),
      ).findings[0];
    expect(parse()?.optionalSuggestion).toBeUndefined();
    expect(parse(true)?.optionalSuggestion).toBe(true);
    expect(parse(false)?.optionalSuggestion).toBe(false);
  });
  it("normalizes LEFT old-line locations consistently with the posting anchor", () => {
    const parsed = parseValidatedReview(
      JSON.stringify({
        results: [
          approved({
            title: "Removed guard leaves an unsafe path",
            severity: "P1",
            path: "src/new.ts",
            old_path: "src/old.ts",
            side: "LEFT",
            line: 20,
            old_line: 10,
            startLine: 8,
            body: "A verified removed-code issue.",
          }),
        ],
      }),
    );
    expect(parsed.approved[0]).toMatchObject({
      line: 20,
      old_line: 10,
      old_path: "src/old.ts",
    });
    expect(parsed.findings[0]).toMatchObject({
      line: 10,
      startLine: 8,
      side: "LEFT",
      path: "src/new.ts",
      oldPath: "src/old.ts",
    });
    expect(parsed.findings[0]?.agent_prompt).toContain("src/old.ts:10");
    expect(parsed.findings[0]?.agent_prompt).not.toContain(":20");
  });
  for (const suggestion of ["    return value;\n", "", "\n", "\tvalue\n\n"]) {
    it(`preserves replacement code exactly: ${JSON.stringify(suggestion)}`, () => {
      const parsed = parseValidatedReview(
        JSON.stringify({
          results: [
            approved({
              title: "Fix the replacement",
              severity: "P1",
              path: "a.py",
              line: 4,
              body: "A verified issue.",
              suggestion,
            }),
          ],
        }),
      );
      expect(parsed.findings[0]?.suggestion).toBe(suggestion);
      expect(parsed.approved[0]?.finding?.suggestion).toBe(suggestion);
    });
  }
  it("preserves legacy comments and infers structured fields", () => {
    const parsed = parseValidatedReview(
      JSON.stringify({
        results: [
          approved({
            path: "a.ts",
            line: 4,
            body: "[P1] [security] Verify signatures\n\nAn unsigned request reaches the handler.",
          }),
        ],
      }),
    );
    expect(parsed.approved[0]).toEqual({
      path: "a.ts",
      line: 4,
      startLine: null,
      side: "RIGHT",
      body: "[P1] [security] Verify signatures\n\nAn unsigned request reaches the handler.",
      old_path: null,
      old_line: null,
    });
    expect(parsed.findings[0]).toMatchObject({
      title: "Verify signatures",
      severity: "P1",
      security: true,
      body: "An unsigned request reaches the handler.",
    });
  });
  it("keeps rich outside-diff findings instead of dropping unanchorable issues", () => {
    const parsed = parseValidatedReview(
      JSON.stringify({
        results: [
          approved({
            id: "f-one",
            title: "Unsafe path",
            severity: "P1",
            security: true,
            securitySeverity: "high",
            path: "old.ts",
            body: "A verified issue.",
            line: null,
            outside_diff: true,
          }),
        ],
      }),
    );
    expect(parsed.approvedCount).toBe(1);
    expect(parsed.approved).toHaveLength(0);
    expect(parsed.outsideDiff).toHaveLength(1);
    expect(parsed.findings[0]?.securitySeverity).toBe("high");
    expect(parsed.skipped).toHaveLength(0);
  });
  it("requires explicit fixed status plus evidence and retains rejection reasons", () => {
    const parsed = parseValidatedReview(
      JSON.stringify({
        results: [
          {
            status: "fixed",
            id: "f-fixed",
            evidence: "Verified the regression test now passes.",
          },
          { status: "fixed", id: "f-no-evidence" },
          {
            status: "rejected",
            candidate: { path: "a.ts", title: "Unproven" },
            reason: "The existing guard handles it.",
          },
        ],
      }),
    );
    expect(parsed.fixedFindings.map((finding) => finding.id)).toEqual([
      "f-fixed",
    ]);
    expect(parsed.fixedFindings[0]?.evidence).toContain("regression test");
    expect(parsed.dropped[0]?.reason).toContain("existing guard");
    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.approved).toHaveLength(0);
  });
  it("keeps deterministic IDs independent of moved line numbers", () => {
    const parse = (line: number) =>
      parseValidatedReview(
        JSON.stringify({
          results: [
            approved({
              path: "a.ts",
              line,
              body: "[P2] Same defect\n\nEvidence.",
            }),
          ],
        }),
      ).findings[0]!.id;
    expect(parse(1)).toBe(parse(50));
  });
  it("does not weaken explicit approval or required path/body validation", () => {
    const parsed = parseValidatedReview(
      JSON.stringify({
        results: [
          { status: "maybe", comment: { path: "a.ts", line: 1, body: "Bad" } },
          approved({ title: "Missing body", path: "a.ts", line: 1 }),
        ],
      }),
    );
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.rejectedCount).toBe(1);
    expect(parsed.skipped).toHaveLength(1);
  });
  it("does not silently downgrade an invalid explicit priority", () => {
    const parsed = parseValidatedReview(
      JSON.stringify({
        results: [
          approved({
            title: "Unknown priority",
            severity: "P99",
            body: "Evidence.",
            path: "a.ts",
            line: 1,
          }),
        ],
      }),
    );
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.skipped[0]?.reason).toContain("severity");
  });
});
