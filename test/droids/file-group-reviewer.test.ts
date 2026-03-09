import { describe, expect, it } from "bun:test";
import { readFile } from "fs/promises";
import { resolve } from "path";

const DROID_PATH = resolve(
  import.meta.dir,
  "../../.factory/droids/file-group-reviewer.md",
);

describe("file-group-reviewer droid config", () => {
  let content: string;

  it("can be read from disk", async () => {
    content = await readFile(DROID_PATH, "utf8");
    expect(content).toBeTruthy();
  });

  it("includes Skill in the tools list", async () => {
    content ??= await readFile(DROID_PATH, "utf8");
    expect(content).toContain('"Skill"');
  });

  it("instructs the subagent to invoke the review-guidelines skill", async () => {
    content ??= await readFile(DROID_PATH, "utf8");
    expect(content).toContain("review-guidelines");
    expect(content).toContain("Skill tool");
  });

  it("includes review-guidelines skill invocation as the first workflow step", async () => {
    content ??= await readFile(DROID_PATH, "utf8");
    const workflowMatch = content.match(/<workflow>([\s\S]*?)<\/workflow>/);
    expect(workflowMatch).not.toBeNull();

    const workflow = workflowMatch![1]!;
    const firstStepMatch = workflow.match(/^[\s]*1\.\s*(.*)/m);
    expect(firstStepMatch).not.toBeNull();
    expect(firstStepMatch![1]).toContain("review-guidelines");
  });
});
