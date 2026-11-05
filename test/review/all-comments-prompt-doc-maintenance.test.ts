import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "prettier";
import { z } from "zod";
import {
  ModuleKind,
  ScriptTarget,
  createSourceFile,
  forEachChild,
  isCallExpression,
  isPropertyAccessExpression,
  transpileModule,
  type Node,
} from "typescript";
import { buildReviewPreviews } from "../../scripts/preview-review";
import {
  BITBUCKET_TERMINOLOGY,
  TRUNCATED_DIFF_NOTE,
  generateBitbucketValidatorPrompt,
} from "../../src/bitbucket/prompts";
import {
  AZURE_DEVOPS_TERMINOLOGY,
  generateAzureDevopsValidatorPrompt,
} from "../../src/azure-devops/prompts";
import { GITHUB_TERMINOLOGY } from "../../src/create-prompt/terminology";
import { generateCandidatesPrompt } from "../../src/core/review/prompts/candidates";
import { generateValidatorPrompt } from "../../src/core/review/prompts/validator";
import type { ReviewPromptContext } from "../../src/core/review/prompts/types";
import { enrichReviewSummary } from "../../src/core/review/validated/metadata";
import { promptOutput } from "../helpers/legacy-review-contract";

const root = join(import.meta.dir, "../..");
const accepted = "9bc0ab98476f2d07a8931048154ccfc430afef9f";
const common: Omit<ReviewPromptContext, "terminology"> = {
  entityNumber: 42,
  repoOrProject: "owner/repo",
  headRef: "feature",
  headSha: "a".repeat(40),
  baseRef: "main",
  diffPath: "/fixture/change.diff",
  commentsPath: "/fixture/comments.json",
  descriptionPath: "/fixture/description.txt",
  candidatesPath: "/fixture/candidates.json",
  validatedPath: "/fixture/validated.json",
  postingMode: "file",
  includeSuggestions: true,
  securityReviewEnabled: true,
};

describe("QA75 prompt output behavior", () => {
  for (const includeSuggestions of [false, true]) {
    it(`candidate body is explanation-only with separate structured security/title/priority (${includeSuggestions})`, () => {
      const prompt = generateCandidatesPrompt({
        ...common,
        terminology: GITHUB_TERMINOLOGY,
        includeSuggestions,
      });
      const [comment] = z
        .array(z.record(z.unknown()))
        .nonempty()
        .parse(promptOutput(prompt, "comments").comments);
      expect(comment.title).toBeTruthy();
      expect(comment.severity).toBe("P1");
      expect(comment.body).not.toMatch(/^\[P[012]\]/);
      expect(comment.body).not.toContain(comment.title);
      expect(prompt).not.toContain("Comment text starting with priority tag");
      expect(prompt).not.toContain("prefixed with `[security]` in their body");
      expect(prompt).toContain("securitySeverity");
      expect(prompt).toContain("outside_diff");
    });
  }
  it("validator leaves deterministic counts/reviewers/checks/security to runtime enrichment", () => {
    const prompt = generateValidatorPrompt({
      ...common,
      terminology: GITHUB_TERMINOLOGY,
    });
    const summary = z
      .record(z.unknown())
      .parse(promptOutput(prompt, "results").reviewSummary);
    for (const field of [
      "filesReviewed",
      "suggestedReviewers",
      "preMergeChecks",
      "security",
    ])
      expect(Object.hasOwn(summary, field)).toBe(false);
    expect(summary.body).toBeTruthy();
    expect(summary.whatChanged).toBeTruthy();
    expect(summary.changes).toHaveLength(1);
    expect(z.record(z.unknown()).parse(summary.risk).level).toBe("Medium");
    expect(summary.filesSkipped).toEqual([]);
    expect(summary.guidelines).toEqual([]);
    expect(prompt).toContain("`diagram`");
    expect(prompt).toContain("`effort`");
    expect(prompt).not.toContain(
      "Emit only the explicitly enabled pre-merge checks",
    );
    expect(prompt).not.toContain(
      "actual security settings, not guessed defaults",
    );
  });
  it("runtime still enriches trusted metadata without model-authored deterministic fields", () => {
    const summary = enrichReviewSummary(
      {
        body: "Evidence-based assessment",
        filesSkipped: [{ path: "generated.js", reason: "Generated" }],
      },
      {
        title: "Preserve trusted runtime metadata",
        description: "Fixes #42 and adds a focused regression test.",
        changedPaths: ["src/index.ts", "generated.js"],
        codeowners: "/src/ @review-team",
        availableReviewers: ["review-team"],
        suggestReviewers: true,
        preMergeChecks: ["title", "description", "linked_issue"],
        security: {
          enabled: true,
          threshold: "high",
          blockOnCritical: true,
          blockOnHigh: false,
        },
      },
    );
    expect(summary.filesReviewed).toBe(1);
    expect(summary.suggestedReviewers).toEqual(["review-team"]);
    expect(summary.preMergeChecks?.map((check) => check.passed)).toEqual([
      true,
      true,
      true,
    ]);
    expect(summary.security?.threshold).toBe("high");
    expect(summary.filesSkipped?.[0]?.reason).toBe("Generated");
  });
  it("actual preview generator preserves alert marker lines after formatting and matches its docs", async () => {
    const source = createSourceFile(
      "preview-review.ts",
      readFileSync(join(root, "scripts/preview-review.ts"), "utf8"),
      ScriptTarget.Latest,
      true,
    );
    let expression: string | undefined;
    function visit(node: Node) {
      if (
        isCallExpression(node) &&
        isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "writeFile"
      )
        expression = node.arguments[1]?.getText(source);
      forEachChild(node, visit);
    }
    visit(source);
    expect(expression).toBeDefined();
    const previews = buildReviewPreviews(
      readFileSync(
        join(root, "test/fixtures/review-ux/validated.json"),
        "utf8",
      ),
    );
    // Execute the real generator's formatted write expression,
    // without starting another Bun or any model/network process.
    const formatted = await new Function(
      "previews",
      "format",
      `return (async () => ${expression})()`,
    )(previews, format);
    expect(await format(formatted, { parser: "markdown" })).toBe(formatted);
    expect(formatted).toMatch(/^> \[!WARNING\]\n> /m);
    expect(formatted).toMatch(/^> \[!IMPORTANT\]\n> /m);
    expect(formatted).not.toMatch(/^> \[![A-Z]+\] .+/m);
    expect(
      await readFile(join(root, "docs/review-ux-preview.md"), "utf8"),
    ).toBe(formatted);
  });
  it("preview CLI writes formatted Markdown matching the documented regeneration output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-preview-cli-"));
    const output = join(directory, "preview.md");
    const startupGuard = process.env.SHALLOW_CI_STARTUP_GUARD;
    try {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          ...(startupGuard ? ["--preload", startupGuard] : []),
          join(root, "scripts/preview-review.ts"),
          output,
        ],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(
        /^Rendered and structurally validated \d+ templates: /,
      );
      expect(stdout).toContain(`: ${output}`);
      const generated = await readFile(output, "utf8");
      expect(generated).toBe(
        await readFile(join(root, "docs/review-ux-preview.md"), "utf8"),
      );
      expect(await format(generated, { parser: "markdown" })).toBe(generated);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});

describe("QA75 legacy FILE byte compatibility, not a new behavior fix", () => {
  // Verbatim accepted source, pinned so shallow checkouts need no Git history.
  // Git blob: b268f78e3d4481bcb5402ff34ab3c93b611a2921.
  const source = readFileSync(
    join(root, "test/fixtures/review-ux/legacy-validator-9bc0ab98476f.ts.txt"),
    "utf8",
  );
  if (
    createHash("sha256").update(source).digest("hex") !==
    "1abe7d734482660d4d2ab7febb55774fad655ae33370423d4ed90d51d2c8cbec"
  )
    throw new Error(
      `Accepted ${accepted}:src/core/review/prompts/legacy-validator.ts fixture digest mismatch`,
    );
  const compiled = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS },
  });
  const baseline: {
    generateValidatorPrompt?: (ctx: ReviewPromptContext) => string;
  } = {};
  // The immutable accepted pure builder has only erased type imports.
  new Function("exports", compiled.outputText)(baseline);
  for (const includeSuggestions of [false, true]) {
    for (const securityReviewEnabled of [false, true]) {
      const options = { ...common, includeSuggestions, securityReviewEnabled };
      it(`complete Bitbucket/Azure FILE output remains exact accepted9bc (${includeSuggestions}/${securityReviewEnabled})`, () => {
        const bitbucket = generateBitbucketValidatorPrompt({
          repoFullName: common.repoOrProject,
          prId: 42,
          sourceBranch: common.headRef,
          targetBranch: common.baseRef,
          headSha: common.headSha,
          diffPath: common.diffPath,
          commentsPath: common.commentsPath,
          descriptionPath: common.descriptionPath,
          candidatesPath: common.candidatesPath,
          validatedPath: common.validatedPath!,
          includeSuggestions,
          securityReviewEnabled,
        });
        expect(bitbucket).toBe(
          baseline.generateValidatorPrompt!({
            ...options,
            terminology: BITBUCKET_TERMINOLOGY,
          }),
        );
        const azure = generateAzureDevopsValidatorPrompt({
          repository: common.repoOrProject,
          pullRequestId: 42,
          sourceBranch: common.headRef,
          targetBranch: common.baseRef,
          headSha: common.headSha,
          diffPath: common.diffPath,
          commentsPath: common.commentsPath,
          descriptionPath: common.descriptionPath,
          candidatesPath: common.candidatesPath,
          validatedPath: common.validatedPath!,
          includeSuggestions,
          securityReviewEnabled,
        });
        expect(azure).toBe(
          baseline.generateValidatorPrompt!({
            ...options,
            terminology: AZURE_DEVOPS_TERMINOLOGY,
          }),
        );
      });
    }
  }
  it("preserves the complete Bitbucket truncation prefix too", () => {
    const prompt = generateBitbucketValidatorPrompt({
      repoFullName: common.repoOrProject,
      prId: 42,
      sourceBranch: common.headRef,
      targetBranch: common.baseRef,
      headSha: common.headSha,
      diffPath: common.diffPath,
      commentsPath: common.commentsPath,
      descriptionPath: common.descriptionPath,
      candidatesPath: common.candidatesPath,
      validatedPath: common.validatedPath!,
      includeSuggestions: true,
      securityReviewEnabled: true,
      diffTruncated: true,
    });
    expect(prompt).toBe(
      `${TRUNCATED_DIFF_NOTE}\n\n${baseline.generateValidatorPrompt!({
        ...common,
        terminology: BITBUCKET_TERMINOLOGY,
      })}`,
    );
  });
});

describe("QA75 source and documentation maintenance", () => {
  it("removes the unused legacy TOOL branch without changing active rich GH/GL builders", () => {
    const source = readFileSync(
      join(root, "src/core/review/prompts/legacy-validator.ts"),
      "utf8",
    );
    expect(source).not.toContain("buildToolPostingSection");
    expect(source).not.toContain('postingMode = "tool"');
    expect(source).not.toContain("requireToolField");
  });
  it("documents both check names and the inline-thread limit, not summary-only fix-all", () => {
    const setup = readFileSync(join(root, "docs/setup.md"), "utf8");
    expect(setup).toContain("`Droid Review`");
    expect(setup).toContain("`Droid Security Review`");
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("open inline Droid finding threads");
    expect(readme).toContain("summary-only");
    expect(readme).toContain("agent prompt");
  });
});
