import {
  parseValidatedReview,
  type ParsedValidatedReview,
} from "./validated/parse";

export type SecurityReportOutcome = {
  id: string;
  disposition: "patched" | "manual";
  fixCommit?: string;
  verification?: string;
};
export type SecurityReportProvenance = {
  sourceRevision?: string;
  sourceRevisionTrusted: boolean;
  outcomes: SecurityReportOutcome[];
};
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

/** Scan-only metadata. Ordinary validator and finding contracts stay unchanged. */
export function parseSecurityReport(
  raw: string,
  expectedSourceRevision?: string,
): { review: ParsedValidatedReview; provenance: SecurityReportProvenance } {
  const review = parseValidatedReview(raw);
  if (expectedSourceRevision !== undefined && !SHA.test(expectedSourceRevision))
    throw new Error("Invalid trusted security scan revision");
  const parsed: unknown = JSON.parse(raw);
  const assertOriginalBindings = (revision: string | undefined) => {
    if (!revision || !record(parsed)) return;
    const check = (value: unknown) => {
      if (value === undefined || value === null) return;
      if (
        typeof value !== "string" ||
        !SHA.test(value) ||
        value.toLowerCase() !== revision
      )
        throw new Error(
          "Security report validator bindings must identify the original scan revision, not a fix commit",
        );
    };
    if (record(parsed.meta)) check(parsed.meta.headSha);
    if (Array.isArray(parsed.results)) {
      for (const result of parsed.results) {
        if (
          record(result) &&
          result.status === "approved" &&
          record(result.comment)
        )
          check(result.comment.commit_id);
      }
    }
  };
  const metadata = record(parsed) ? parsed.securityReport : undefined;
  const provenance: SecurityReportProvenance = {
    ...(expectedSourceRevision
      ? { sourceRevision: expectedSourceRevision.toLowerCase() }
      : {}),
    sourceRevisionTrusted: !!expectedSourceRevision,
    outcomes: [],
  };
  if (metadata === undefined) {
    assertOriginalBindings(provenance.sourceRevision);
    return { review, provenance };
  }
  if (
    !record(metadata) ||
    typeof metadata.sourceRevision !== "string" ||
    !SHA.test(metadata.sourceRevision) ||
    !Array.isArray(metadata.outcomes)
  )
    throw new Error("Invalid security report provenance");
  const revision = metadata.sourceRevision.toLowerCase();
  if (
    expectedSourceRevision &&
    revision !== expectedSourceRevision.toLowerCase()
  )
    throw new Error(
      "Security report source revision differs from the pre-model scan revision",
    );
  provenance.sourceRevision = revision;
  assertOriginalBindings(revision);
  const approved = new Set(review.findings.map((finding) => finding.id));
  const seen = new Set<string>();
  for (const outcome of metadata.outcomes) {
    if (
      !record(outcome) ||
      typeof outcome.id !== "string" ||
      !approved.has(outcome.id) ||
      seen.has(outcome.id) ||
      !["patched", "manual"].includes(String(outcome.disposition))
    )
      throw new Error("Invalid or unmatched security remediation outcome");
    seen.add(outcome.id);
    if (outcome.disposition === "patched") {
      if (
        typeof outcome.fixCommit !== "string" ||
        !SHA.test(outcome.fixCommit) ||
        outcome.fixCommit.toLowerCase() === revision ||
        typeof outcome.verification !== "string" ||
        !outcome.verification.trim()
      )
        throw new Error(
          "Reported patches require a distinct fix commit and verification outcome",
        );
      provenance.outcomes.push({
        id: outcome.id,
        disposition: "patched",
        fixCommit: outcome.fixCommit.toLowerCase(),
        verification: outcome.verification.trim(),
      });
    } else {
      provenance.outcomes.push({ id: outcome.id, disposition: "manual" });
    }
  }
  return { review, provenance };
}
