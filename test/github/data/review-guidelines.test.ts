import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import {
  fetchAndStoreReviewGuidelines,
  loadReviewGuidelinesStoredForValidator,
} from "../../../src/github/data/review-guidelines";

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

  it("returns nothing when the repository has no guidelines, without retrying", async () => {
    const { octokit, spy } = octokitReturning(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );

    const result = await fetchAndStoreReviewGuidelines({
      octokit,
      owner: "acme",
      repo: "web",
      baseRef: "main",
      tempDir: "/tmp/test",
      retryDelayMs: 0,
    });

    expect(result).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  it("retries a transient failure before giving up on the guidelines", async () => {
    let calls = 0;
    const getContent = () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(Object.assign(new Error("boom"), { status: 502 }))
        : Promise.resolve({
            data: { content: Buffer.from(SKILL).toString("base64") },
          });
    };
    const octokit = { rest: { repos: { getContent } } } as any;

    const result = await fetchAndStoreReviewGuidelines({
      octokit,
      owner: "acme",
      repo: "web",
      baseRef: "main",
      tempDir: "/tmp/test",
      retryDelayMs: 0,
    });

    expect(calls).toBe(2);
    expect(result?.body).toBe("# Rules\n\n- Keep PRs small.");
  });

  it("keeps the review going when every attempt fails", async () => {
    const { octokit, spy } = octokitReturning(
      Object.assign(new Error("boom"), { status: 500 }),
    );
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchAndStoreReviewGuidelines({
      octokit,
      owner: "acme",
      repo: "web",
      baseRef: "main",
      tempDir: "/tmp/test",
      retryDelayMs: 0,
    });

    expect(result).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("boom");
    warnSpy.mockRestore();
  });
});

describe("loadReviewGuidelinesStoredForValidator", () => {
  it("reloads the copy the candidates step stored for the same base branch", async () => {
    const readFileSpy = spyOn(fsPromises, "readFile").mockResolvedValue(
      "# Rules\n\n- Keep PRs small.",
    );

    const result = await loadReviewGuidelinesStoredForValidator({
      baseRef: "develop",
      tempDir: "/tmp/test",
    });

    expect(readFileSpy).toHaveBeenCalledWith(
      "/tmp/test/droid-prompts/review_guidelines.md",
      "utf8",
    );
    expect(result).toEqual({
      source: ".factory/skills/review-guidelines/SKILL.md@develop",
      body: "# Rules\n\n- Keep PRs small.",
      path: "/tmp/test/droid-prompts/review_guidelines.md",
    });
    readFileSpy.mockRestore();
  });

  it("returns nothing when the candidates step stored no guidelines", async () => {
    const readFileSpy = spyOn(fsPromises, "readFile").mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const result = await loadReviewGuidelinesStoredForValidator({
      baseRef: "main",
      tempDir: "/tmp/test",
    });

    expect(result).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    readFileSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
