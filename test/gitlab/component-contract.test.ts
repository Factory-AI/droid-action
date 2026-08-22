/**
 * Contract tests for the GitLab CI/CD Component and the drop-in examples.
 *
 * The template and the examples are plain YAML that no compiler checks, and
 * they are the only thing a consuming project actually copies. These tests
 * pin the parts that silently break consumers: the job's trigger rule, the
 * step order, the "Droid gets no MR-mutation tool" guarantee, and the
 * variable wiring that GitLab cannot expand.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parseAllDocuments, parse } from "yaml";

const repoRoot = path.resolve(import.meta.dir, "../..");

function read(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

const templateSource = read("templates/droid-review.yml");
const templateDocs = parseAllDocuments(templateSource).map((doc) =>
  doc.toJS({ mapAsMap: false }),
);
const spec = templateDocs[0] as {
  spec: { inputs: Record<string, { default?: string; description?: string }> };
};
const jobs = templateDocs[1] as Record<string, any>;
const reviewJob = jobs["droid-review"];
const scriptText: string = [
  ...(reviewJob.before_script ?? []),
  ...(reviewJob.script ?? []),
].join("\n");
const afterScriptText: string = (reviewJob.after_script ?? []).join("\n");

const exampleFiles = [
  "gitlab/examples/factory/droid-review.yml",
  ...fs
    .readdirSync(path.join(repoRoot, "gitlab/examples/variants"))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => `gitlab/examples/variants/${name}`),
];

describe("droid-review component template", () => {
  it("declares the job in a second YAML document with the input-driven stage", () => {
    expect(templateDocs).toHaveLength(2);
    expect(Object.keys(jobs)).toEqual(["droid-review"]);
    expect(reviewJob.stage).toBe("$[[ inputs.stage ]]");
  });

  it("only runs on merge request pipelines", () => {
    expect(reviewJob.rules).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "merge_request_event"' },
    ]);
  });

  it("runs the five review steps in order", () => {
    const order = [
      "gitlab-prepare.ts",
      "Pass 1 (candidates)",
      "gitlab-prepare-validator.ts",
      "Pass 2 (validator)",
      "gitlab-post-review.ts",
    ].map((needle) => ({ needle, at: scriptText.indexOf(needle) }));

    for (const step of order) {
      expect(step.at, `missing step: ${step.needle}`).toBeGreaterThan(-1);
    }
    const positions = order.map((step) => step.at);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("renders the tracking note from after_script so failures still report", () => {
    expect(afterScriptText).toContain("gitlab-update-comment-link.ts");
    // after_script runs in a fresh shell, so the failure signal has to be a
    // file rather than an exported variable.
    expect(afterScriptText).toContain("/tmp/droid-error.txt");
    expect(afterScriptText).toContain("DROID_SUCCESS=false");
  });

  it("posts through the REST API rather than an MCP server", () => {
    expect(scriptText).not.toContain("droid mcp add");
    expect(scriptText).not.toContain("gitlab_mr");
    expect(scriptText).not.toContain("gitlab-mr-server");
  });

  it("gives neither droid exec pass a tool that can write to the MR", () => {
    const toolLists = [...scriptText.matchAll(/PASS\d_TOOLS="([^"]+)"/g)].map(
      (match) => match[1]!.split(","),
    );
    expect(toolLists).toHaveLength(2);
    for (const tools of toolLists) {
      expect(tools.some((tool) => tool.startsWith("mcp__"))).toBe(false);
      expect(tools).toContain("Read");
      expect(tools).not.toContain("submit_review");
    }
  });

  it("always uploads the state file and debug artifacts", () => {
    expect(reviewJob.artifacts.when).toBe("always");
    expect(reviewJob.artifacts.paths).toEqual([
      ".droid-state.json",
      ".droid-debug/",
    ]);
  });

  it("keeps every input documented with a default", () => {
    for (const [name, input] of Object.entries(spec.spec.inputs)) {
      expect(input.description ?? "", `${name} description`).not.toBe("");
      expect(input.default, `${name} default`).toBeDefined();
    }
  });
});

describe("drop-in examples", () => {
  it("ships the default example plus the variants", () => {
    expect(exampleFiles.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of exampleFiles) {
    describe(file, () => {
      const config = parse(read(file)) as Record<string, any>;
      const include = config.include?.[0];

      it("includes the component template", () => {
        expect(include?.file).toBe("/templates/droid-review.yml");
        expect(include?.ref).toBeTruthy();
      });

      it("passes only inputs the component declares", () => {
        for (const name of Object.keys(include?.inputs ?? {})) {
          expect(
            Object.keys(spec.spec.inputs),
            `unknown input: ${name}`,
          ).toContain(name);
        }
      });

      it("never maps a CI/CD variable to itself", () => {
        // GitLab cannot expand a self-reference and hands the job the
        // literal "$NAME", which surfaces as an opaque 401.
        for (const [name, value] of Object.entries(
          (config["droid-review"]?.variables ?? {}) as Record<string, string>,
        )) {
          expect(value, `${name} maps to itself`).not.toBe(`$${name}`);
        }
      });

      it("keeps the merge-request gate when it overrides rules", () => {
        const rules = config["droid-review"]?.rules;
        if (!rules) return;
        for (const rule of rules) {
          expect(rule.if).toContain("merge_request_event");
        }
      });
    });
  }
});

describe("documented snippets", () => {
  const docs = [
    "README.md",
    "docs/gitlab-setup.md",
    "gitlab/examples/README.md",
  ];

  it("never tell a reader to map a variable to itself", () => {
    for (const doc of docs) {
      const body = read(doc);
      for (const name of ["GITLAB_TOKEN", "FACTORY_API_KEY"]) {
        // Allowed inside prose that warns against it; only an indented YAML
        // mapping line is a copy-pasteable instruction.
        const offenders = body
          .split("\n")
          .filter((line) =>
            new RegExp(`^\\s+${name}: \\$${name}\\s*$`).test(line),
          );
        expect(offenders, `${doc} maps ${name} to itself`).toEqual([]);
      }
    }
  });
});
