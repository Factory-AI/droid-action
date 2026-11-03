import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateGitlabReviewCandidatesPrompt } from "../../src/gitlab/prompts/candidates";
import { generateGitlabReviewValidatorPrompt } from "../../src/gitlab/prompts/validator";
import { reviewPromptSettingsFromEnvironment } from "../../src/core/review/prompts/settings";
import { reviewConfigFromEnvironment } from "../../src/core/review/config";

const settings = {
  REVIEW_SEVERITY_THRESHOLD: "P1",
  SECURITY_SEVERITY_THRESHOLD: "high",
  SECURITY_BLOCK_ON_CRITICAL: "false",
  SECURITY_BLOCK_ON_HIGH: "true",
};
const context = {
  projectPath: "group/project",
  mrIid: 42,
  mrTitle: "Example change",
  sourceBranch: "feature",
  targetBranch: "main",
  headSha: "abcdef1234567890",
  diffPath: "/tmp/gitlab/mr.diff",
  commentsPath: "/tmp/gitlab/comments.json",
  descriptionPath: "/tmp/gitlab/description.txt",
  candidatesPath: "/tmp/gitlab/candidates.json",
  validatedPath: "/tmp/gitlab/validated.json",
  includeSuggestions: true,
  securityReviewEnabled: true,
  reviewSettings: reviewPromptSettingsFromEnvironment(settings),
  priorFindingsPath: "/tmp/gitlab/previous_findings.json",
};

describe("GitLab lifecycle prompt protocol", () => {
  for (const [pass, generate] of [
    ["candidate", generateGitlabReviewCandidatesPrompt],
    ["validator", generateGitlabReviewValidatorPrompt],
  ] as const) {
    it(`${pass} uses the actual GitLab manifest and trusted security settings`, () => {
      const prompt = generate(context);
      expect(prompt).toContain(context.priorFindingsPath);
      expect(prompt).not.toContain("review_prior_findings.json");
      expect(prompt).toContain("securitySeverity");
      expect(prompt).toMatch(/critical[\s\S]*high[\s\S]*medium[\s\S]*low/);
      expect(prompt).toContain('"securitySeverityThreshold": "high"');
      expect(prompt).toContain('"securityBlockOnCritical": false');
      expect(prompt).toContain('"securityBlockOnHigh": true');
      expect(prompt).toMatch(/dismissed/i);
      expect(prompt).toMatch(/untrusted/i);
      expect(prompt).not.toContain("github_pr___submit_review");
    });

    it(`${pass} accepts first-run absence without inventing prior findings`, () => {
      const prompt = generate({ ...context, priorFindingsPath: undefined });
      expect(prompt).toMatch(/absence is valid|absent on the first run/i);
    });
  }

  it("validator keeps eligible fix evidence separate from candidate results", () => {
    const prompt = generateGitlabReviewValidatorPrompt(context);
    expect(prompt).toContain("findingResolutions");
    expect(prompt).toContain("eligibleFixedIds");
    expect(prompt).toContain("evidence");
    expect(prompt).toMatch(/one entry per candidate|one result per candidate/i);
    expect(prompt).toMatch(/absence is not|absent candidate.*not/i);
  });

  it("real validator preparation passes the actual manifest path from state", async () => {
    const dir = await mkdtemp(
      path.join(tmpdir(), "gitlab-lifecycle-contract-"),
    );
    try {
      const promptPath = path.join(dir, "prompt.txt");
      const candidatesPath = path.join(dir, "candidates.json");
      const statePath = path.join(dir, "state.json");
      const priorPath = path.join(dir, "previous_findings.json");
      await writeFile(candidatesPath, JSON.stringify({ comments: [] }));
      await writeFile(
        priorPath,
        JSON.stringify({ eligibleFixedIds: ["stable-prior"], verifyFixed: [] }),
      );
      await writeFile(
        statePath,
        JSON.stringify({
          ...context,
          shouldRunReview: true,
          promptPath,
          candidatesPath,
          reviewConfig: reviewConfigFromEnvironment(settings),
          previousReviewState: { head: "0123456789abcdef", findings: [] },
        }),
      );
      const child = Bun.spawn(
        [process.execPath, "src/entrypoints/gitlab-prepare-validator.ts"],
        {
          cwd: path.resolve(import.meta.dir, "../.."),
          env: { DROID_STATE_FILE: statePath },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const prompt = await readFile(promptPath, "utf8");
      expect(prompt).toContain(priorPath);
      expect(prompt).not.toContain("review_prior_findings.json");
      expect(prompt).toContain("findingResolutions");
      expect(prompt).toContain("securitySeverity");
      expect(prompt).toContain('"securityBlockOnHigh": true');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
