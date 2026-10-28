#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderCheckRun,
  renderInlineComment,
  renderReviewBody,
  renderReviewSummary,
  renderSecurityReport,
  renderStaleReviewBody,
  renderStepSummary,
  validateRenderedMarkdown,
  type ReviewRenderInput,
} from "../src/core/review/render";
import { parseValidatedReview } from "../src/core/review/validated/parse";
import {
  decodeFindingMarker,
  decodeReviewMarker,
  decodeReviewState,
  decodeSeverityMarker,
  hasSummaryMarker,
} from "../src/core/review/markers";

const fixturePath = fileURLToPath(
  new URL("../test/fixtures/review-ux/validated.json", import.meta.url),
);

export function buildReviewPreviews(raw: string): Record<string, string> {
  const review = parseValidatedReview(raw);
  const findings = review.findings.map((f) => ({
    ...f,
    isNew: true,
    ...(!f.outside_diff
      ? {
          threadUrl:
            "https://github.com/example/repo/pull/42#discussion_r4405524178",
        }
      : {}),
  }));
  const input: ReviewRenderInput = {
    state: "findings",
    head: review.commitId ?? "9ea6c83",
    base: "1a2b3c40123456789abcdef0123456789abcdef012",
    repositoryUrl: "https://github.com/example/repo",
    summaryUrl: "https://github.com/example/repo/pull/42#issuecomment-123",
    jobUrl: "https://github.com/example/repo/actions/runs/123/job/456",
    findings,
    summary: review.summary,
    dropped: review.dropped,
    candidatesConsidered: review.findings.length + review.rejectedCount,
    postedCount: findings.length,
    durationSeconds: 134,
    depth: "deep",
    model: "configured-model",
    showDroppedFindings: true,
  };
  const summary = renderReviewSummary(input);
  const cleanInput: ReviewRenderInput = {
    ...input,
    state: "clean",
    findings: [],
    postedCount: 0,
    dropped: [
      ...review.dropped,
      ...findings.map((f, index) => ({
        index: review.dropped.length + index,
        path: f.path,
        title: f.title,
        reason:
          "Validation confirmed an existing guard prevents this candidate.",
      })),
    ],
    summary: {
      ...review.summary,
      body: "All candidates were dismissed after validation.",
    },
  };
  const checkInput = {
    ...input,
    steps: [
      {
        name: "Gathered PR context",
        status: "completed" as const,
        durationSeconds: 4,
      },
      {
        name: `Generated ${input.candidatesConsidered} candidates`,
        status: "completed" as const,
        durationSeconds: 91,
      },
      {
        name: "Validated candidates",
        status: "completed" as const,
        durationSeconds: 38,
      },
      {
        name: "Posted review",
        status: "completed" as const,
        durationSeconds: 2,
      },
    ],
  };
  const previews: Record<string, string> = {
    "Summary with findings": summary,
    "Clean summary": renderReviewSummary(cleanInput),
    "In-progress summary": renderReviewSummary({
      ...input,
      state: "in_progress",
      startedAt: "2026-10-28T12:00:00Z",
      previousBody: summary,
      previousHead: "7f3e2a1",
    }),
    "Failed summary": renderReviewSummary({
      ...input,
      state: "failed",
      error: "Factory API 401: FACTORY_API_KEY=sk-fixturesecret123",
    }),
    "Skipped summary": renderReviewSummary({
      ...input,
      state: "skipped",
      skipReason: "Draft PR.",
    }),
    "Re-review summary": renderReviewSummary({
      ...input,
      findings: findings.map((f) => ({ ...f, isNew: false })),
      resolved: findings.slice(0, 1).map((f) => ({
        ...f,
        id: "f-resolved-tenant",
        title: "Cache key ignores the tenant identifier",
        fixedIn: "7f3e2a1",
      })),
      unchangedSuggestions: 2,
    }),
    "Blocking summary": renderReviewSummary({ ...input, blocked: true }),
    "Review body": renderReviewBody(input),
    "Stale review body": renderStaleReviewBody("7f3e2a1", input.head!),
    "Queued check": Object.values(
      renderCheckRun({ ...checkInput, phase: "queued" }),
    ).join("\n\n"),
    "Running check": Object.values(
      renderCheckRun({ ...checkInput, phase: "in_progress" }),
    ).join("\n\n"),
    "Completed check": Object.values(renderCheckRun(checkInput)).join("\n\n"),
    "Failed check": Object.values(
      renderCheckRun({ ...checkInput, state: "failed", error: "timeout" }),
    ).join("\n\n"),
    "Skipped check": Object.values(
      renderCheckRun({
        ...checkInput,
        state: "skipped",
        skipReason: "No new changes since 7f3e2a1",
      }),
    ).join("\n\n"),
    "Clean check": Object.values(renderCheckRun(cleanInput)).join("\n\n"),
    "Step summary": renderStepSummary(input),
    "Full security report": renderSecurityReport(input),
    "Summary emoji badges": renderReviewSummary({ ...input, badges: "emoji" }),
    "Summary text badges": renderReviewSummary({ ...input, badges: "text" }),
    "Summary without agent prompts": renderReviewSummary({
      ...input,
      includeAgentPrompts: false,
    }),
    "Summary without diagram": renderReviewSummary({
      ...input,
      diagram: "off",
    }),
    "Summary persisted state": renderReviewSummary({
      ...input,
      reviewState: {
        head: input.head!,
        base: input.base,
        paused: false,
        autoRunCount: 1,
        findings: findings.map((f) => ({
          id: f.id,
          sev: f.severity,
          state: "open",
          path: f.path,
          finding: f,
        })),
      },
    }),
    "GitLab summary": renderReviewSummary({
      ...input,
      platform: "gitlab",
      repositoryUrl: "https://gitlab.example.com/group/project",
      summaryUrl:
        "https://gitlab.example.com/group/project/-/merge_requests/42#note_123",
      jobUrl: "https://gitlab.example.com/group/project/-/jobs/456",
      findings: findings.map((f) => ({
        ...f,
        threadUrl: f.outside_diff
          ? undefined
          : "https://gitlab.example.com/group/project/-/merge_requests/42#note_456",
      })),
    }),
  };
  for (const [index, finding] of findings.entries()) {
    for (const badges of ["image", "emoji", "text"] as const)
      previews[`Inline ${index + 1} (${badges})`] = renderInlineComment(
        finding,
        { ...input, badges },
      );
  }
  for (const [name, body] of Object.entries(previews)) {
    const errors = validateRenderedMarkdown(body);
    if (/summary/i.test(name) && !hasSummaryMarker(body))
      errors.push("Summary marker does not parse");
    if (/inline/i.test(name) && !decodeFindingMarker(body))
      errors.push("Finding marker does not parse");
    if (/review body/i.test(name) && !decodeReviewMarker(body))
      errors.push("Review marker does not parse");
    if (/check/i.test(name) && !decodeSeverityMarker(body))
      errors.push("Severity marker does not parse");
    if (name === "Summary persisted state" && !decodeReviewState(body))
      errors.push("Review state does not parse");
    if (errors.length) throw new Error(`${name}: ${errors.join("; ")}`);
  }
  return previews;
}

if (import.meta.main) {
  const output = path.resolve(
    process.argv[2] ?? "/tmp/droid-review-ux-preview.md",
  );
  const source = process.argv[3] ? path.resolve(process.argv[3]) : fixturePath;
  const previews = buildReviewPreviews(await fs.readFile(source, "utf8"));
  await fs.writeFile(
    output,
    Object.entries(previews)
      .map(([name, body]) => `# ${name}\n\n${body}`)
      .join("\n\n---\n\n") + "\n",
  );
  console.log(
    `Rendered and structurally validated ${Object.keys(previews).length} templates: ${output}`,
  );
}
