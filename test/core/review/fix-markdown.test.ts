import { describe, expect, it } from "bun:test";
import { fixMarkdown } from "../../../src/core/review/render/fix-markdown";
import { validateRenderedMarkdown } from "../../../src/core/review/render";

describe("fixMarkdown", () => {
  it("closes an unclosed fence so it cannot swallow the rest of the comment", () => {
    expect(fixMarkdown("```diff\n- a\n+ b")).toBe("~~~diff\n- a\n+ b\n~~~");
  });

  it("escapes HTML, links, images, headings, quotes and tables in text", () => {
    const out = fixMarkdown(
      [
        "<details><summary>x</summary>hi</details>",
        "<img src=x onerror=alert(1)>",
        "see [link](https://evil.example) ![i](https://x.example/i.png)",
        "# Title",
        "---",
        "> quote",
        "| a | b |",
      ].join("\n"),
    )!;
    expect(out).not.toMatch(/<[a-z]/i);
    expect(out).toContain("\\[link\\]\\(");
    expect(out).toContain("\\!\\[i\\]");
    expect(out).toContain("\\# Title");
    expect(out).toContain("\\---");
    expect(out).toContain("&gt; quote");
    expect(out).toContain("\\| a \\| b \\|");
    expect(validateRenderedMarkdown(out)).toEqual([]);
  });

  it("breaks mentions in text", () => {
    expect(fixMarkdown("ping @octocat")).toBe("ping @\u200boctocat");
  });

  it("turns a suggestion fence into text so it adds no apply button", () => {
    expect(fixMarkdown("```suggestion\nfoo\n```")).toBe("~~~text\nfoo\n~~~");
  });

  it("keeps passive Mermaid and turns unsafe Mermaid into text", () => {
    expect(fixMarkdown("```mermaid\nflowchart LR\nA-->B\n```")).toBe(
      "~~~mermaid\nflowchart LR\nA-->B\n~~~",
    );
    expect(
      fixMarkdown('```mermaid\nflowchart LR\nA-->B\nclick A "https://x"\n```'),
    ).toStartWith("~~~text\n");
  });

  it("keeps inner fences inside a longer rebuilt fence", () => {
    expect(fixMarkdown("```ts\nconst a = `~~~`;\n```")).toBe(
      "~~~~ts\nconst a = `~~~`;\n~~~~",
    );
    expect(fixMarkdown("````\n```\ninner\n```\n````")).toBe(
      "~~~text\n```\ninner\n```\n~~~",
    );
  });

  it("keeps common language names and turns unknown ones into text", () => {
    expect(fixMarkdown("```python\nx = 1\n```")).toBe("~~~python\nx = 1\n~~~");
    expect(fixMarkdown("```html-evil\nx\n```")).toBe("~~~text\nx\n~~~");
  });

  it("reads a backtick line with a backtick info string as inline code, not a fence", () => {
    expect(fixMarkdown("```js```\nafter")).toBe("<code>js</code>\nafter");
  });

  it("escapes a spaced thematic break instead of reading it as a list item", () => {
    expect(fixMarkdown("- - -")).toBe("\\- - -");
    expect(fixMarkdown("* * *")).toBe("\\* \\* \\*");
  });

  it("keeps inline code as code and escapes HTML inside it", () => {
    expect(fixMarkdown("use `<script>` here")).toBe(
      "use <code>&lt;script&gt;</code> here",
    );
  });

  it("normalizes CRLF and drops empty fences", () => {
    expect(fixMarkdown("a\r\n```diff\r\n+x\r\n```")).toBe(
      "a\n\n~~~diff\n+x\n~~~",
    );
    expect(fixMarkdown("```diff\n\n```")).toBeNull();
  });
});
