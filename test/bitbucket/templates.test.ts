import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import { parse } from "yaml";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const CLONE =
  'git clone --depth 1 --branch "${DROID_ACTION_REF:-main}" https://github.com/Factory-AI/droid-action.git /tmp/droid-action';
const RUN = "bash /tmp/droid-action/bitbucket/droid-review.sh";

function expectReviewStep(step: any) {
  expect(step.name).toBe("Droid code review");
  expect(step.image).toBe("oven/bun:1.2.11");
  expect(step["max-time"]).toBeGreaterThan(0);
  expect(step.script).toHaveLength(3);
  expect(step.script[0]).toContain("apt-get install");
  expect(step.script[0]).toContain("git");
  expect(step.script[0]).toContain("curl");
  expect(step.script[1]).toBe(CLONE);
  expect(step.script[2]).toBe(RUN);
  expect(step.artifacts).toEqual([".droid-debug/**"]);
}

describe("Bitbucket Pipelines templates", () => {
  it("single-repo template runs the review on every pull request", () => {
    const doc = parse(read("bitbucket/pipelines/bitbucket-pipelines.yml"));
    expect(Object.keys(doc)).toEqual(["pipelines"]);
    expect(Object.keys(doc.pipelines)).toEqual(["pull-requests"]);
    const steps = doc.pipelines["pull-requests"]["**"];
    expect(steps).toHaveLength(1);
    expectReviewStep(steps[0].step);
  });

  it("shared pipeline exports the droid-review pipeline with the same step", () => {
    const doc = parse(read("bitbucket/pipelines/shared-pipeline.yml"));
    expect(doc.export).toBe(true);
    const pipeline = doc.definitions.pipelines["droid-review"];
    expect(pipeline).toHaveLength(1);
    expectReviewStep(pipeline[0].step);
    // The import line documented for consumers names this pipeline.
    expect(read("bitbucket/pipelines/shared-pipeline.yml")).toContain(
      "import: droid-pipelines:main:droid-review",
    );
  });
});

describe("Bitbucket Data Center CI examples", () => {
  it("Bamboo spec builds pull-request plan branches and runs the entrypoint", () => {
    const doc = parse(read("bitbucket/examples/bamboo-specs.yml"));
    expect(doc.version).toBe(2);
    expect(doc.branches.create).toBe("for-pull-request");
    for (const v of [
      "BITBUCKET_SERVER_URL",
      "BITBUCKET_PROJECT_KEY",
      "BITBUCKET_REPO_SLUG",
      "DROID_ACTION_REF",
    ]) {
      expect(doc.variables[v]).toBeTruthy();
    }
    const jobName = doc.stages[0].Review.jobs[0];
    const script = doc[jobName].tasks[0].script.scripts[0] as string;
    expect(script).toContain("bamboo_repository_pr_key");
    expect(script).toContain(
      'export DROID_BITBUCKET_TOKEN="$bamboo_DROID_BITBUCKET_TOKEN_SECRET"',
    );
    expect(script).toContain(
      'export FACTORY_API_KEY="$bamboo_FACTORY_API_KEY_SECRET"',
    );
    expect(script).toContain(RUN);
  });

  it("Jenkinsfile runs only for change requests with both credentials bound", () => {
    const jenkinsfile = read("bitbucket/examples/Jenkinsfile");
    expect(jenkinsfile).toContain("when { changeRequest() }");
    expect(jenkinsfile).toContain("variable: 'FACTORY_API_KEY'");
    expect(jenkinsfile).toContain("variable: 'DROID_BITBUCKET_TOKEN'");
    expect(jenkinsfile).toContain(RUN);
    // Balanced braces: a cheap guard against a broken Groovy edit.
    const opens = (jenkinsfile.match(/{/g) ?? []).length;
    const closes = (jenkinsfile.match(/}/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});

describe("droid-review.sh", () => {
  const script = read("bitbucket/droid-review.sh");

  it("calls entrypoints that exist", () => {
    const entrypoints = [
      ...script.matchAll(/src\/entrypoints\/([\w-]+\.ts)/g),
    ].map((m) => m[1]!);
    expect(new Set(entrypoints)).toEqual(
      new Set([
        "bitbucket-update-comment-link.ts",
        "bitbucket-prepare.ts",
        "bitbucket-prepare-validator.ts",
        "bitbucket-post-review.ts",
      ]),
    );
    for (const e of entrypoints) {
      expect(existsSync(path.join(ROOT, "src/entrypoints", e))).toBe(true);
    }
  });
});
