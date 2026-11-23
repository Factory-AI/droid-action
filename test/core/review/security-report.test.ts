import { describe, expect, it } from "bun:test";
import { parseSecurityReport } from "../../../src/core/review/security-report";
import { parseValidatedReview } from "../../../src/core/review/validated/parse";
import { renderSecurityReport } from "../../../src/core/review/render";

const SOURCE = "a".repeat(40);
const FIX = "b".repeat(40);
function document() {
  return {
    version: 1,
    results: [
      {
        status: "approved",
        comment: {
          id: "scan-1",
          title: "Unsafe sink",
          body: "Original evidence",
          severity: "P1",
          security: true,
          path: "src/original.ts",
          line: 4,
          outside_diff: true,
        },
      },
    ],
    securityReport: {
      sourceRevision: SOURCE,
      outcomes: [
        {
          id: "scan-1",
          disposition: "patched",
          fixCommit: FIX,
          verification: "Regression passed",
        },
      ],
    },
  };
}
describe("scan-only provenance contract shared by GitHub and GitLab", () => {
  for (const declared of ["meta", "comment", "mixed"]) {
    it(`${declared}: rejects post-fix validator commit bindings while retaining the original scan source`, () => {
      const raw: any = document();
      if (declared === "meta") raw.meta = { headSha: FIX };
      if (declared === "comment") raw.results[0].comment.commit_id = FIX;
      if (declared === "mixed") {
        raw.results[0].comment.commit_id = SOURCE;
        raw.results.push({
          status: "approved",
          comment: {
            ...raw.results[0].comment,
            id: "scan-2",
            commit_id: FIX,
          },
        });
      }
      expect(() => parseSecurityReport(JSON.stringify(raw), SOURCE)).toThrow();
    });
  }
  it("keeps the original validator head and comments distinct from fixCommit", () => {
    const raw: any = document();
    raw.meta = { headSha: SOURCE };
    raw.results[0].comment.commit_id = SOURCE;
    expect(
      parseSecurityReport(JSON.stringify(raw), SOURCE).review.commitId,
    ).toBe(SOURCE);
  });
  for (const platform of ["github", "gitlab"] as const) {
    it(`${platform}: fixes are reported separately from original evidence`, () => {
      const parsed = parseSecurityReport(JSON.stringify(document()), SOURCE);
      const body = renderSecurityReport({
        platform,
        repositoryUrl: `https://${platform}.com/o/r`,
        head: FIX,
        state: "findings",
        findings: parsed.review.findings,
        securityReport: parsed.provenance,
      });
      expect(body).toContain("Reported patched");
      expect(body).toContain("not independently verified");
      expect(body).toContain(
        `${platform === "gitlab" ? "-/" : ""}blob/${SOURCE}/src/original.ts#L4`,
      );
      expect(body).not.toContain(`blob/${FIX}/`);
      expect(parsed.review.commitId).toBeNull();
      expect(parsed.provenance.sourceRevisionTrusted).toBe(true);
    });
  }
  it("qualifies model-only original revisions as reported, never trusted", () => {
    const parsed = parseSecurityReport(JSON.stringify(document()));
    expect(parsed.provenance.sourceRevisionTrusted).toBe(false);
    expect(
      renderSecurityReport({
        state: "findings",
        findings: parsed.review.findings,
        securityReport: parsed.provenance,
      }),
    ).toContain("reported revision, not independently bound");
  });
  it("does not invent a source from the report's fixed head for legacy data", () => {
    const raw = document();
    const parsed = parseSecurityReport(
      JSON.stringify({ version: 1, results: raw.results }),
    );
    const body = renderSecurityReport({
      state: "findings",
      head: FIX,
      repositoryUrl: "https://github.com/o/r",
      findings: parsed.review.findings,
      securityReport: parsed.provenance,
    });
    expect(body).toContain("original revision not recorded");
    expect(body).toContain("Remediation status not reported");
    expect(body).not.toContain(`/blob/${FIX}/`);
  });
  it("retains independently bound original revisions for legacy scans", () => {
    const parsed = parseSecurityReport(
      JSON.stringify({ version: 1, results: document().results }),
      SOURCE,
    );
    expect(parsed.provenance).toEqual({
      sourceRevision: SOURCE,
      sourceRevisionTrusted: true,
      outcomes: [],
    });
  });
  for (const invalid of [
    "revision",
    "duplicate",
    "rejected",
    "commit",
    "verification",
    "disposition",
  ]) {
    it(`fails closed for ${invalid} metadata`, () => {
      const raw = document();
      if (invalid === "revision") raw.securityReport.sourceRevision = FIX;
      if (invalid === "duplicate")
        raw.securityReport.outcomes.push(raw.securityReport.outcomes[0]!);
      if (invalid === "rejected") raw.results[0]!.status = "rejected";
      if (invalid === "commit")
        raw.securityReport.outcomes[0]!.fixCommit = SOURCE;
      if (invalid === "verification")
        raw.securityReport.outcomes[0]!.verification = "";
      if (invalid === "disposition")
        raw.securityReport.outcomes[0]!.disposition = "fixed";
      expect(() => parseSecurityReport(JSON.stringify(raw), SOURCE)).toThrow();
    });
  }
  it("does not promote report fix commits into ordinary validator commits or fixed decisions", () => {
    const parsed = parseValidatedReview(JSON.stringify(document()));
    expect(parsed.commitId).toBeNull();
    expect(parsed.fixedFindings).toEqual([]);
    expect(parsed.findings[0]).not.toHaveProperty("fixCommit");
  });
});
