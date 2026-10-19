import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const TEMPLATE_PATH = path.join(REPO_ROOT, "azure-devops/droid-review.yml");
const raw = fs.readFileSync(TEMPLATE_PATH, "utf8");
const pipeline = parse(raw) as Record<string, any>;

describe("azure-devops/droid-review.yml", () => {
  it("only runs from a branch policy", () => {
    expect(pipeline.trigger).toBe("none");
    expect(pipeline.pr).toBe("none");
  });

  it("uses a pool the skill can swap for a self-hosted one", () => {
    expect(pipeline.pool).toEqual({ vmImage: "ubuntu-latest" });
  });

  it("links the secrets group and pins droid-action", () => {
    expect(pipeline.variables).toContainEqual({ group: "droid-review" });
    const vars = Object.fromEntries(
      pipeline.variables
        .filter((v: any) => v.name)
        .map((v: any) => [v.name, v.value]),
    );
    expect(vars.DROID_ACTION_REPO).toBe(
      "https://github.com/Factory-AI/droid-action.git",
    );
    expect(vars.DROID_ACTION_REF).toBe("main");
  });

  it("checks out full history without persisting credentials", () => {
    const checkout = pipeline.steps[0];
    expect(checkout).toMatchObject({
      checkout: "self",
      fetchDepth: 0,
      persistCredentials: false,
    });
  });

  it("maps the token and secrets explicitly and runs the shipped script", () => {
    const step = pipeline.steps.find((s: any) => typeof s.bash === "string");
    expect(step.env.SYSTEM_ACCESSTOKEN).toBe("$(System.AccessToken)");
    expect(step.env.FACTORY_API_KEY).toBe("$(FACTORY_API_KEY)");
    expect(step.env.AZURE_DEVOPS_PAT).toBe("$(AZURE_DEVOPS_PAT)");
    expect(step.env).toMatchObject({
      AUTOMATIC_REVIEW: "true",
      AUTOMATIC_SECURITY_REVIEW: "false",
      REVIEW_DEPTH: "deep",
    });
    const script = step.bash as string;
    expect(script).toContain(
      'git clone --quiet --depth 1 --branch "$DROID_ACTION_REF" "$DROID_ACTION_REPO"',
    );
    const runPath = script.match(/bash "\$DROID_ACTION_DIR\/(\S+)"/)?.[1];
    expect(runPath).toBe("azure-devops/run-review.sh");
    expect(fs.existsSync(path.join(REPO_ROOT, runPath!))).toBe(true);
  });

  it("publishes debug artifacts even when the review fails", () => {
    const publish = pipeline.steps.find((s: any) => s.publish);
    expect(publish).toMatchObject({
      publish: "$(Agent.TempDirectory)/droid-debug",
      condition: "always()",
      continueOnError: true,
    });
  });

  it("only uses steps available on self-hosted agents", () => {
    for (const step of pipeline.steps) {
      const kind = Object.keys(step).find((k) =>
        ["checkout", "bash", "publish", "task", "script"].includes(k),
      );
      expect(["checkout", "bash", "publish"]).toContain(kind);
    }
  });

  it("is embedded verbatim in the setup guide", () => {
    const doc = fs.readFileSync(
      path.join(REPO_ROOT, "docs/azure-devops-setup.md"),
      "utf8",
    );
    expect(doc).toContain("```yaml\n" + raw.trimEnd() + "\n```");
  });
});
