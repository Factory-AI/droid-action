import { describe, it, expect } from "bun:test";
import { generateGitlabFillPrompt } from "../../src/gitlab/prompts/fill";

const baseCtx = {
  projectPath: "group/project",
  mrIid: 7,
  mrTitle: "Refactor user service",
  sourceBranch: "feature/x",
  targetBranch: "main",
  triggerSource: "description" as const,
  triggerPhrase: "@droid",
  descriptionPath: "/tmp/droid-prompts/mr_description.txt",
  diffPath: "/tmp/droid-prompts/mr.diff",
};

describe("generateGitlabFillPrompt", () => {
  it("references the MR by IID and project", () => {
    const out = generateGitlabFillPrompt(baseCtx);
    expect(out).toContain("merge request !7 in group/project");
  });

  it("names the only MR-mutation tool: update_mr_description", () => {
    const out = generateGitlabFillPrompt(baseCtx);
    expect(out).toContain("gitlab_mr___update_mr_description");
    expect(out).not.toContain("gitlab_mr___submit_review");
    expect(out).not.toContain("gitlab_mr___update_tracking_note");
  });

  it("tells the model to strip the trigger phrase from the new description", () => {
    const out = generateGitlabFillPrompt(baseCtx);
    expect(out).toContain("Strip the trigger phrase");
    expect(out).toContain("@droid fill");
  });

  it("includes the artifact paths it expects to read", () => {
    const out = generateGitlabFillPrompt(baseCtx);
    expect(out).toContain("/tmp/droid-prompts/mr_description.txt");
    expect(out).toContain("/tmp/droid-prompts/mr.diff");
  });

  it("includes the GitLab MR template paths to look for", () => {
    const out = generateGitlabFillPrompt(baseCtx);
    expect(out).toContain(".gitlab/merge_request_templates/Default.md");
    expect(out).toContain(".gitlab/merge_request_templates/default.md");
  });

  it("forbids ticket inference from indirect sources", () => {
    const out = generateGitlabFillPrompt(baseCtx);
    expect(out).toContain("ticket references");
    expect(out).toContain("commit messages");
  });

  it("communicates which trigger surface fired", () => {
    const out = generateGitlabFillPrompt({
      ...baseCtx,
      triggerSource: "label",
    });
    expect(out).toContain("detected via **label**");
  });
});
