import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import {
  fetchAndStoreReviewGuidelines,
  fetchRequestedReviewSkill,
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

describe("fetchRequestedReviewSkill", () => {
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

  const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
  const file = (text: string) => ({
    data: { content: Buffer.from(text).toString("base64") },
  });
  const dir = (...entries: Array<[string, string]>) => ({
    data: entries.map(([name, type]) => ({ name, type })),
  });
  const PLUGINS = ".factory/factory-mono-plugins/plugins";

  function repo(files: Record<string, unknown>) {
    const getContent = async ({ path, ref }: { path: string; ref: string }) => {
      expect(ref).toBe("dev");
      if (path in files) {
        const value = files[path];
        if (value instanceof Error) throw value;
        return value;
      }
      throw notFound();
    };
    const octokit = { rest: { repos: { getContent } } } as any;
    return { octokit, spy: spyOn(octokit.rest.repos, "getContent") };
  }
  const lookup = (octokit: any, name = "deep-review") =>
    fetchRequestedReviewSkill({
      octokit,
      owner: "acme",
      repo: "web",
      baseRef: "dev",
      tempDir: "/tmp/test",
      name,
      retryDelayMs: 0,
    });

  it("prefers .factory/skills and never lists plugins when it has the skill", async () => {
    const { octokit, spy } = repo({
      ".factory/skills/deep-review/SKILL.md": file("---\nname: x\n---\nTop"),
      [PLUGINS]: dir(["dev-workflows", "dir"]),
      [`${PLUGINS}/dev-workflows/skills/deep-review/SKILL.md`]: file("Plugin"),
    });
    expect(await lookup(octokit)).toEqual({
      status: "found",
      skill: {
        source: ".factory/skills/deep-review/SKILL.md@dev",
        body: "Top",
        path: "/tmp/test/droid-prompts/requested_review_skill.md",
      },
    });
    expect(spy.mock.calls.some((call: any[]) => call[0].path === PLUGINS)).toBe(
      false,
    );
  });

  it("falls back to the one plugin that has the skill, skipping files and unsafe directory names", async () => {
    const { octokit, spy } = repo({
      [PLUGINS]: dir(
        ["qa", "dir"],
        ["dev-workflows", "dir"],
        ["README.md", "file"],
        ["..", "dir"],
        ["Bad.Name", "dir"],
      ),
      [`${PLUGINS}/dev-workflows/skills/deep-review/SKILL.md`]: file(
        "---\nname: deep-review\n---\n# Deep",
      ),
    });
    expect(await lookup(octokit)).toEqual({
      status: "found",
      skill: {
        source: `${PLUGINS}/dev-workflows/skills/deep-review/SKILL.md@dev`,
        body: "# Deep",
        path: "/tmp/test/droid-prompts/requested_review_skill.md",
      },
    });
    const paths = spy.mock.calls.map((call: any[]) => call[0].path).sort();
    expect(paths).toEqual(
      [
        ".factory/skills/deep-review/SKILL.md",
        PLUGINS,
        `${PLUGINS}/dev-workflows/skills/deep-review/SKILL.md`,
        `${PLUGINS}/qa/skills/deep-review/SKILL.md`,
      ].sort(),
    );
  });

  it("refuses a name more than one plugin has, listing them in order", async () => {
    const { octokit } = repo({
      [PLUGINS]: dir(["qa", "dir"], ["dev-workflows", "dir"]),
      [`${PLUGINS}/qa/skills/deep-review/SKILL.md`]: file("A"),
      [`${PLUGINS}/dev-workflows/skills/deep-review/SKILL.md`]: file("B"),
    });
    expect(await lookup(octokit)).toEqual({
      status: "ambiguous",
      paths: [
        `${PLUGINS}/dev-workflows/skills/deep-review/SKILL.md`,
        `${PLUGINS}/qa/skills/deep-review/SKILL.md`,
      ],
    });
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  it("reports a missing skill, including an empty one or a repository without plugins", async () => {
    expect(await lookup(repo({}).octokit)).toEqual({ status: "missing" });
    expect(
      await lookup(
        repo({
          ".factory/skills/deep-review/SKILL.md": file("---\nname: x\n---\n"),
        }).octokit,
      ),
    ).toEqual({ status: "missing" });
  });

  it("fails instead of calling the skill missing when GitHub cannot be read", async () => {
    const { octokit } = repo({
      ".factory/skills/deep-review/SKILL.md": Object.assign(
        new Error("Forbidden"),
        { status: 403 },
      ),
    });
    await expect(lookup(octokit)).rejects.toThrow("Forbidden");
  });
});
