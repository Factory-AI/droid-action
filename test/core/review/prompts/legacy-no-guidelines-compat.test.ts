import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ModuleKind, transpileModule } from "typescript";
import {
  AZURE_DEVOPS_TERMINOLOGY,
  generateAzureDevopsCandidatesPrompt,
  generateAzureDevopsValidatorPrompt,
} from "../../../../src/azure-devops/prompts";
import {
  BITBUCKET_TERMINOLOGY,
  generateBitbucketCandidatesPrompt,
  generateBitbucketValidatorPrompt,
} from "../../../../src/bitbucket/prompts";
import type { ReviewPromptContext } from "../../../../src/core/review/prompts/types";

async function baseline(
  file: string,
  exported: string,
  sha256: string,
): Promise<(context: ReviewPromptContext) => string> {
  const source = await readFile(
    new URL(`../../../fixtures/rebase-legacy/${file}.ts.txt`, import.meta.url),
    "utf8",
  );
  if (createHash("sha256").update(source).digest("hex") !== sha256)
    throw new Error("Frozen legacy fixture digest mismatch");
  const compiled = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS },
  });
  const exports: Record<string, unknown> = {};
  new Function("exports", compiled.outputText)(exports);
  const generate = exports[exported];
  if (typeof generate !== "function")
    throw new Error("Frozen legacy fixture has no prompt builder");
  return (context) => {
    const result: unknown = generate(context);
    if (typeof result !== "string")
      throw new Error("Frozen legacy fixture did not return prompt text");
    return result;
  };
}

const candidates = await baseline(
  "candidates-65aa",
  "generateCandidatesPrompt",
  "f10fc0173a9a4a1818e1afe0d659f1290d64dbc0a685389d9eed1ca28ee8dce5",
);
const validator = await baseline(
  "validator-65aa",
  "generateValidatorPrompt",
  "ffcf20cafe9fbc6ef440a0b569e3a13a54183b2080f391dc543f2a383caee1bf",
);
const common = {
  sourceBranch: "feature",
  targetBranch: "main",
  headSha: "a".repeat(40),
  diffPath: "/owned/diff",
  commentsPath: "/owned/comments",
  descriptionPath: "/owned/description",
  candidatesPath: "/owned/candidates",
  validatedPath: "/owned/validated",
};

describe("rebased legacy prompts without repository guidelines", () => {
  it("preserves complete Azure DevOps prompt bytes for both passes", () => {
    for (const includeSuggestions of [false, true])
      for (const securityReviewEnabled of [false, true]) {
        const context = {
          ...common,
          includeSuggestions,
          securityReviewEnabled,
          repository: "project/repo",
          pullRequestId: 4,
        };
        const frozen: ReviewPromptContext = {
          ...context,
          terminology: AZURE_DEVOPS_TERMINOLOGY,
          entityNumber: 4,
          repoOrProject: context.repository,
          headRef: common.sourceBranch,
          baseRef: common.targetBranch,
        };
        expect(generateAzureDevopsCandidatesPrompt(context)).toBe(
          candidates(frozen),
        );
        expect(generateAzureDevopsValidatorPrompt(context)).toBe(
          validator(frozen),
        );
      }
  });

  it("preserves complete Bitbucket prompt bytes for both passes", () => {
    for (const includeSuggestions of [false, true])
      for (const securityReviewEnabled of [false, true]) {
        const context = {
          ...common,
          includeSuggestions,
          securityReviewEnabled,
          repoFullName: "workspace/repo",
          prId: 4,
        };
        const frozen: ReviewPromptContext = {
          ...context,
          terminology: BITBUCKET_TERMINOLOGY,
          entityNumber: 4,
          repoOrProject: context.repoFullName,
          headRef: common.sourceBranch,
          baseRef: common.targetBranch,
        };
        expect(generateBitbucketCandidatesPrompt(context)).toBe(
          candidates(frozen),
        );
        expect(generateBitbucketValidatorPrompt(context)).toBe(
          validator(frozen),
        );
      }
  });
});
