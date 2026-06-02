import { describe, it, expect } from "bun:test";
import {
  buildFillRegex,
  checkContainsFillTrigger,
  stripFillTrigger,
} from "../../src/gitlab/validation/trigger";

describe("buildFillRegex", () => {
  it("matches @droid fill with leading whitespace", () => {
    const re = buildFillRegex("@droid");
    expect(re.test("hello @droid fill please")).toBe(true);
  });

  it("matches at start of string", () => {
    const re = buildFillRegex("@droid");
    expect(re.test("@droid fill")).toBe(true);
  });

  it("is case-insensitive", () => {
    const re = buildFillRegex("@droid");
    expect(re.test("@Droid Fill")).toBe(true);
  });

  it("requires at least one space between phrase and fill", () => {
    const re = buildFillRegex("@droid");
    expect(re.test("@droidfill")).toBe(false);
  });

  it("does not match @droid review", () => {
    const re = buildFillRegex("@droid");
    expect(re.test("@droid review")).toBe(false);
  });

  it("respects a custom trigger phrase", () => {
    const re = buildFillRegex("@bot");
    expect(re.test("@bot fill")).toBe(true);
    expect(re.test("@droid fill")).toBe(false);
  });
});

describe("checkContainsFillTrigger", () => {
  const baseArgs = {
    description: null,
    title: null,
    labels: [] as string[],
    triggerPhrase: "@droid",
    automaticFill: false,
  };

  it("matches when description contains the phrase", () => {
    const result = checkContainsFillTrigger({
      ...baseArgs,
      description: "@droid fill",
    });
    expect(result).toEqual({ matched: true, source: "description" });
  });

  it("matches when title contains the phrase", () => {
    const result = checkContainsFillTrigger({
      ...baseArgs,
      title: "WIP @droid fill",
    });
    expect(result).toEqual({ matched: true, source: "title" });
  });

  it("matches when droid:fill label is present", () => {
    const result = checkContainsFillTrigger({
      ...baseArgs,
      labels: ["DROID:Fill"],
    });
    expect(result).toEqual({ matched: true, source: "label" });
  });

  it("matches when automatic_fill is true and no explicit trigger", () => {
    const result = checkContainsFillTrigger({
      ...baseArgs,
      automaticFill: true,
    });
    expect(result).toEqual({ matched: true, source: "automatic_fill" });
  });

  it("prefers description over title over label over automatic_fill", () => {
    const result = checkContainsFillTrigger({
      description: "@droid fill",
      title: "@droid fill",
      labels: ["droid:fill"],
      triggerPhrase: "@droid",
      automaticFill: true,
    });
    expect(result.source).toBe("description");
  });

  it("returns matched=false when nothing matches", () => {
    const result = checkContainsFillTrigger({
      ...baseArgs,
      description: "just a normal MR",
      title: "Refactor user service",
    });
    expect(result).toEqual({ matched: false, source: "none" });
  });
});

describe("stripFillTrigger", () => {
  it("removes the trigger phrase from a description", () => {
    expect(stripFillTrigger("@droid fill", "@droid")).toBe("");
  });

  it("removes the trigger phrase from surrounding text", () => {
    expect(stripFillTrigger("Please @droid fill this MR", "@droid")).toBe(
      "Please this MR",
    );
  });

  it("collapses repeated whitespace after stripping", () => {
    expect(stripFillTrigger("foo   @droid fill   bar", "@droid")).toBe(
      "foo bar",
    );
  });

  it("is case-insensitive", () => {
    expect(stripFillTrigger("Hello @Droid Fill there", "@droid")).toBe(
      "Hello there",
    );
  });

  it("is a no-op when no trigger is present", () => {
    expect(stripFillTrigger("nothing to strip", "@droid")).toBe(
      "nothing to strip",
    );
  });
});
