import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import { fetchAndStoreReviewGuidelines } from "../../../src/github/data/review-guidelines";

const SKILL =
  "---\nname: review-guidelines\ndescription: Rules\n---\n\n# Rules\n\n- Keep PRs small.\n";

function octokitReturning(content: string | Error) {
  const getContent =
    content instanceof Error
      ? () => Promise.reject(content)
      : () =>
          Promise.resolve({
            data: { content: Buffer.from(content).toString("base64") },
          });
  const octokit = { rest: { repos: { getContent } } } as any;
  return { octokit, spy: spyOn(octokit.rest.repos, "getContent") };
}

describe("fetchAndStoreReviewGuidelines", () => {
  let writeFileSpy: ReturnType<typeof spyOn>;
  let mkdirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    writeFileSpy = spyOn(fsPromises, "writeFile").mockResolvedValue();
    mkdirSpy = spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
  });

  afterEach(() => {
    writeFileSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it("reads the skill from the base branch, strips frontmatter and stores a copy", async () => {
    const { octokit, spy } = octokitReturning(SKILL);

    const result = await fetchAndStoreReviewGuidelines({
      octokit,
      owner: "acme",
      repo: "web",
      baseRef: "develop",
      tempDir: "/tmp/test",
    });

    expect(spy).toHaveBeenCalledWith({
      owner: "acme",
      repo: "web",
      path: ".factory/skills/review-guidelines/SKILL.md",
      ref: "develop",
    });
    expect(result).toEqual({
      source: ".factory/skills/review-guidelines/SKILL.md@develop",
      body: "# Rules\n\n- Keep PRs small.",
      path: "/tmp/test/droid-prompts/review_guidelines.md",
    });
    expect(writeFileSpy).toHaveBeenCalledWith(
      "/tmp/test/droid-prompts/review_guidelines.md",
      "# Rules\n\n- Keep PRs small.",
    );
  });

  it("returns nothing when the repository has no guidelines", async () => {
    const { octokit } = octokitReturning(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );

    const result = await fetchAndStoreReviewGuidelines({
      octokit,
      owner: "acme",
      repo: "web",
      baseRef: "main",
      tempDir: "/tmp/test",
    });

    expect(result).toBeUndefined();
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  it("keeps the review going when the read fails for another reason", async () => {
    const { octokit } = octokitReturning(
      Object.assign(new Error("boom"), { status: 500 }),
    );
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchAndStoreReviewGuidelines({
      octokit,
      owner: "acme",
      repo: "web",
      baseRef: "main",
      tempDir: "/tmp/test",
    });

    expect(result).toBeUndefined();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("boom");
    warnSpy.mockRestore();
  });
});
