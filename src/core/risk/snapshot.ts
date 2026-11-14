import {
  RISK_SNAPSHOT_PLACEHOLDER,
  type PrRiskEvidenceWorkspace,
  type PullRequestRiskFile,
  type PullRequestRiskFileKind,
  type PullRequestRiskInput,
  type PullRequestRiskSnapshot,
  type PullRequestRiskSnapshotFile,
  type RiskPriorDecline,
} from "./types";

const TEST_PATH =
  /(?:^|\/)(?:__tests__|e2e|test|tests)(?:\/|$)|\.(?:spec|test)\.[^.]+$/i;
const DOCS_PATH = /(?:^|\/)(?:docs?|examples?)(?:\/|$)|\.(?:md|mdx|rst|txt)$/i;
const EXECUTABLE_MARKDOWN_PATH =
  /(?:^|\/)(?:prompts?|skills?|\.factory)(?:\/|$)|(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$/i;
const GENERATED_OR_LOCK_PATH =
  /(?:^|\/)(?:__snapshots__|fixtures?|generated|dist|coverage)(?:\/|$)|(?:^|\/)(?:package-lock\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml|dependency-graph\.json)$/i;
const WORKSPACE_PATH = /^(apps|packages|internal|infra|evals)\/([^/]+)\//;

function classifyFile(filename: string): PullRequestRiskFileKind {
  if (GENERATED_OR_LOCK_PATH.test(filename)) return "generated_or_lock";
  if (TEST_PATH.test(filename)) return "test";
  // Prompts, skills and agent instructions are Markdown that changes behavior.
  if (EXECUTABLE_MARKDOWN_PATH.test(filename)) return "runtime";
  if (DOCS_PATH.test(filename)) return "docs";
  return "runtime";
}

function deriveWorkspaces(paths: readonly string[]): string[] {
  const workspaces = new Set<string>();
  for (const path of paths) {
    const match = WORKSPACE_PATH.exec(path);
    workspaces.add(match ? `${match[1]}/${match[2]}` : "root");
  }
  return [...workspaces].sort();
}

/**
 * Builds the compact exact-head inventory presented to the judge. Patch
 * bodies live in the on-disk diff and never enter this snapshot.
 */
export function buildPrRiskSnapshot(
  pullRequest: PullRequestRiskInput,
  files: readonly PullRequestRiskFile[],
  priorDeclines: readonly RiskPriorDecline[] = [],
): PullRequestRiskSnapshot {
  const categorized = files
    .map<PullRequestRiskSnapshotFile>((file) => ({
      ...file,
      kind: classifyFile(file.filename),
    }))
    .sort((left, right) => left.filename.localeCompare(right.filename));

  const ofKind = (kind: PullRequestRiskFileKind) =>
    categorized.filter((file) => file.kind === kind);
  const runtimeFiles = ofKind("runtime");
  const testFiles = ofKind("test");
  const linesChanged = (rows: readonly PullRequestRiskFile[]): number =>
    rows.reduce((total, file) => total + file.additions + file.deletions, 0);

  return {
    pullRequest,
    priorDeclines,
    summary: {
      runtimeFiles: runtimeFiles.length,
      testFiles: testFiles.length,
      docsFiles: ofKind("docs").length,
      generatedOrLockFiles: ofKind("generated_or_lock").length,
      runtimeLinesChanged: linesChanged(runtimeFiles),
      testLinesChanged: linesChanged(testFiles),
      unlistedFiles: Math.max(0, pullRequest.changedFiles - files.length),
      workspaces: deriveWorkspaces(
        categorized
          .filter((file) => file.kind === "runtime" || file.kind === "test")
          .map((file) => file.filename),
      ),
    },
    files: categorized,
  };
}

/**
 * Renders the judge's skill for one pull request: the snapshot (without the
 * base revision, which the judge never sees) replaces the placeholder in the
 * skill body, or is appended when the skill carries none.
 */
export function renderPrRiskSkill(
  skill: string,
  snapshot: PullRequestRiskSnapshot,
  evidence: PrRiskEvidenceWorkspace,
): string {
  const { baseSha: _baseSha, ...pullRequest } = snapshot.pullRequest;
  const snapshotJson = JSON.stringify(
    {
      pullRequest,
      summary: snapshot.summary,
      changedFiles: snapshot.files,
      priorDeclines: snapshot.priorDeclines,
      evidence: {
        diffPath: evidence.diffPath,
        headTreePath: evidence.headTreeDir,
        inventoryPath: evidence.inventoryPath,
        guidelinesPath: evidence.guidelinesPath,
      },
    },
    null,
    2,
  );
  if (skill.includes(RISK_SNAPSHOT_PLACEHOLDER)) {
    // A replacer function, because a replacement string would expand `$&` and
    // similar patterns that a pull request title can contain.
    return skill.replaceAll(RISK_SNAPSHOT_PLACEHOLDER, () => snapshotJson);
  }
  return `${skill.trimEnd()}\n\n## PR snapshot\n\n\`\`\`json\n${snapshotJson}\n\`\`\`\n`;
}
