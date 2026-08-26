import { afterEach, describe, expect, test } from "bun:test";
import { defaultStewardConfig, loadStewardConfig } from "../src/steward/config";
import {
  isTrustedRun,
  hasSystemicWorkflowFailure,
  resolvePullRequest,
  shouldProcessWorkflow,
  shouldSkipPullRequest,
  waitForChecksToFinish,
  workflowsPassedOnCommit,
} from "../src/steward/gate";
import { prepareMcpTools } from "../src/mcp/install-mcp-server";
import { DroidRunType } from "../src/run-type";
import {
  STEWARD_ALLOWED_TOOLS,
  buildActionConfig,
  stewardAllowedTools,
  stewardRunCount,
  stewardRunSha,
  isCommitAlreadyProcessed,
} from "../src/steward/index";
import { protectedViolations } from "../src/steward/postrun";
import {
  checkCategories,
  checkMatchesScope,
  checksInScope,
} from "../src/steward/scope";

const octokitWithConfig = (body: string) =>
  ({
    rest: {
      repos: {
        getContent: async () => ({
          data: { content: Buffer.from(body, "utf8").toString("base64") },
        }),
      },
    },
  }) as any;

const load = (body: string, inputs = {}) =>
  loadStewardConfig(
    octokitWithConfig(body),
    "owner",
    "repo",
    "main",
    ".github/droid-ci.yml",
    inputs,
  );

describe("CI Steward gates", () => {
  test("only processes failed or timed out workflows", () => {
    const config = defaultStewardConfig();
    const event = {
      workflow_run: { name: "CI", conclusion: "failure" },
    } as any;
    expect(shouldProcessWorkflow(event, config)).toBe(true);
    event.workflow_run.conclusion = "success";
    expect(shouldProcessWorkflow(event, config)).toBe(false);
  });

  test("honors workflow exclusions", () => {
    const config = defaultStewardConfig();
    config.workflows.exclude = ["Deploy *"];
    expect(
      shouldProcessWorkflow(
        {
          workflow_run: { name: "Deploy production", conclusion: "failure" },
        } as any,
        config,
      ),
    ).toBe(false);
  });

  test("skips configured draft, label, branch, and author cases", () => {
    const config = defaultStewardConfig();
    expect(
      shouldSkipPullRequest(
        {
          number: 1,
          headSha: "sha",
          headRef: "feature",
          baseRef: "release/1",
          author: "bot",
          draft: true,
        },
        {
          ...config,
          skip: { ...config.skip, branches: ["release/*"], authors: ["bot"] },
        },
        ["no-droid-ci"],
      ),
    ).toBe(true);
  });
});

describe("CI Steward MCP wiring", () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  // A workflow_run payload is not an entity context, so every server gated on
  // isEntityContext has to fall back to STEWARD_PR_NUMBER. When one does not, the
  // CLI aborts the run with "Unknown tool identifier(s)" for its tools.
  test("installs a server for every namespaced tool CI Steward allows", async () => {
    process.env.STEWARD_PR_NUMBER = "42";
    process.env.DEFAULT_WORKFLOW_TOKEN = "workflow-token";

    const config = JSON.parse(
      await prepareMcpTools({
        githubToken: "app-token",
        owner: "owner",
        repo: "repo",
        droidCommentId: "1",
        runType: DroidRunType.CiSteward,
        allowedTools: STEWARD_ALLOWED_TOOLS,
        mode: "tag",
        context: {
          eventName: "workflow_run",
          repository: { owner: "owner", repo: "repo" },
        } as any,
      }),
    );

    const installed = Object.keys(config.mcpServers ?? {});
    const required = [
      ...new Set(
        STEWARD_ALLOWED_TOOLS.filter((tool) => tool.includes("___")).map(
          (tool) => tool.split("___")[0]!,
        ),
      ),
    ];

    expect(required.length).toBeGreaterThan(0);
    for (const server of required) {
      expect(installed).toContain(server);
    }
  });

  // MCP server env values are interpolated into `droid mcp add ... --env K=V`
  // as an unquoted shell string, so a value holding a space or a shell
  // metacharacter breaks registration and aborts the whole run.
  test("keeps every MCP env value safe for an unquoted shell argument", async () => {
    process.env.STEWARD_PR_NUMBER = "42";
    process.env.STEWARD_RUN_ID = "31044951094";
    process.env.STEWARD_RUN_COUNT = "1";
    process.env.DEFAULT_WORKFLOW_TOKEN = "workflow-token";

    const config = JSON.parse(
      await prepareMcpTools({
        githubToken: "app-token",
        owner: "owner",
        repo: "repo",
        droidCommentId: "1",
        runType: DroidRunType.CiSteward,
        allowedTools: STEWARD_ALLOWED_TOOLS,
        mode: "tag",
        context: {
          eventName: "workflow_run",
          repository: { owner: "owner", repo: "repo" },
        } as any,
      }),
    );

    for (const server of Object.values<any>(config.mcpServers ?? {})) {
      for (const [key, value] of Object.entries(server.env ?? {})) {
        expect(`${key}=${String(value)}`).not.toMatch(/[\s"'<>|&;$`\\]/);
      }
    }
  });

  test("passes the steward pull request number to the inline comment server", async () => {
    process.env.STEWARD_PR_NUMBER = "42";
    process.env.DEFAULT_WORKFLOW_TOKEN = "workflow-token";

    const config = JSON.parse(
      await prepareMcpTools({
        githubToken: "app-token",
        owner: "owner",
        repo: "repo",
        droidCommentId: "1",
        runType: DroidRunType.CiSteward,
        allowedTools: STEWARD_ALLOWED_TOOLS,
        mode: "tag",
        context: {
          eventName: "workflow_run",
          repository: { owner: "owner", repo: "repo" },
        } as any,
      }),
    );

    expect(config.mcpServers.github_inline_comment.env.PR_NUMBER).toBe("42");
  });
});

describe("CI Steward run budget", () => {
  const bot = { id: 209825114, type: "Bot" };
  const human = { id: 5, type: "User" };
  const markerFor = (count: number) =>
    `## CI Steward\n\ndiagnosis text\n\n<!-- ci-steward:run=99 count=${count} -->`;

  // The count has to live in the marker, not in the number of marker comments:
  // Droid rewrites the tracking comment body on every run.
  test("reads the lifetime count from the surviving marker", () => {
    expect(
      stewardRunCount([
        { body: "unrelated", user: human },
        { body: markerFor(3), user: bot },
      ]),
    ).toBe(3);
  });

  test("treats a pull request with no steward history as zero runs", () => {
    expect(stewardRunCount([{ body: "some human comment", user: human }])).toBe(
      0,
    );
  });

  test("does not undercount when Droid has rewritten the body around the marker", () => {
    const rewritten = `## CI Steward\n\n**Diagnosis: real code failure.**\n\nlots of new content\n\n<!-- ci-steward:run=12345 count=7 -->`;
    expect(stewardRunCount([{ body: rewritten, user: bot }])).toBe(7);
  });

  // Anyone can comment on a pull request, so honouring a marker regardless of
  // author let a contributor pin the count at zero for unlimited paid runs.
  test("ignores a marker planted by a non-bot commenter", () => {
    expect(
      stewardRunCount([
        { body: "<!-- ci-steward:run=1 count=0 -->", user: human },
        { body: markerFor(4), user: bot },
      ]),
    ).toBe(4);
  });

  // Each watched workflow that fails raises its own event for one commit, and
  // every one of them used to pay for a full analysis of the same information.
  test("records the analyzed commit alongside the count", () => {
    const body = `## CI Steward\n\ndiagnosis\n\n<!-- ci-steward:run=99 count=2 sha=abc1234def -->`;
    expect(stewardRunCount([{ body, user: bot }])).toBe(2);
    expect(stewardRunSha([{ body, user: bot }])).toBe("abc1234def");
  });

  test("reads a marker written before commits were recorded", () => {
    const legacy = [{ body: markerFor(3), user: bot }];
    expect(stewardRunCount(legacy)).toBe(3);
    expect(stewardRunSha(legacy)).toBeUndefined();
  });

  test("ignores a human marker even when no genuine marker exists", () => {
    expect(
      stewardRunCount([
        { body: "<!-- ci-steward:run=1 count=999 -->", user: human },
      ]),
    ).toBe(0);
  });

  test("skips a second workflow failing on an already analyzed commit", () => {
    expect(isCommitAlreadyProcessed("abc123f", "abc123f", 1)).toBe(true);
  });

  test("still analyzes a different commit", () => {
    expect(isCommitAlreadyProcessed("abc123f", "def456a", 1)).toBe(false);
  });

  // A rerun that fails again is a new outcome, not a duplicate event.
  test("still analyzes a failed rerun of the same commit", () => {
    expect(isCommitAlreadyProcessed("abc123f", "abc123f", 2)).toBe(false);
  });

  test("analyzes when no commit was ever recorded", () => {
    expect(isCommitAlreadyProcessed(undefined, "abc123f", 1)).toBe(false);
  });
});

describe("CI Steward trust boundary", () => {
  const forkEvent = (fullName: string) =>
    ({
      workflow_run: { head_repository: { full_name: fullName } },
    }) as any;

  test("rejects a run whose head commit came from a fork", () => {
    expect(isTrustedRun(forkEvent("attacker/repo"), "owner", "repo")).toBe(
      false,
    );
  });

  test("accepts a run from a branch in the base repository", () => {
    expect(isTrustedRun(forkEvent("owner/repo"), "owner", "repo")).toBe(true);
  });

  test("rejects a run with no head repository rather than assuming trust", () => {
    expect(isTrustedRun({ workflow_run: {} } as any, "owner", "repo")).toBe(
      false,
    );
  });
});

describe("CI Steward base commit gate", () => {
  const runs = (workflowRuns: { name: string; conclusion: string }[]) =>
    ({
      rest: {
        actions: {
          listWorkflowRunsForRepo: async () => ({
            data: { workflow_runs: workflowRuns },
          }),
        },
      },
    }) as any;

  test("allows a fix only when every failing workflow passed on the base", async () => {
    await expect(
      workflowsPassedOnCommit(
        runs([
          { name: "Tests", conclusion: "success" },
          { name: "Typecheck", conclusion: "success" },
        ]),
        "owner",
        "repo",
        "base-sha",
        ["Tests", "Typecheck"],
      ),
    ).resolves.toBe(true);
  });

  test("withholds a fix when a failing workflow already failed on the base", async () => {
    await expect(
      workflowsPassedOnCommit(
        runs([{ name: "Tests", conclusion: "failure" }]),
        "owner",
        "repo",
        "base-sha",
        ["Tests"],
      ),
    ).resolves.toBe(false);
  });

  test("withholds a fix when the base has no matching workflow run", async () => {
    await expect(
      workflowsPassedOnCommit(runs([]), "owner", "repo", "base-sha", ["Tests"]),
    ).resolves.toBe(false);
  });
});

describe("CI Steward systemic failure gate", () => {
  const runs = (workflowRuns: unknown[]) =>
    ({
      rest: {
        actions: {
          listWorkflowRunsForRepo: async () => ({
            data: { workflow_runs: workflowRuns },
          }),
        },
      },
    }) as any;
  const failedRun = (
    pullNumber: number,
    overrides: Record<string, unknown> = {},
  ) => ({
    name: "Tests",
    head_sha: `sha-${pullNumber}`,
    conclusion: "failure",
    created_at: new Date(Date.now() - 60_000).toISOString(),
    pull_requests: [{ number: pullNumber }],
    ...overrides,
  });

  test("withholds a fix when the same workflow fails on five other PRs", async () => {
    await expect(
      hasSystemicWorkflowFailure(
        runs([
          failedRun(2),
          failedRun(3),
          failedRun(4),
          failedRun(5),
          failedRun(6),
        ]),
        "owner",
        "repo",
        "current-sha",
        ["Tests"],
      ),
    ).resolves.toBe(true);
  });

  test("does not treat repeated runs for one other PR as systemic", async () => {
    await expect(
      hasSystemicWorkflowFailure(
        runs([failedRun(2), failedRun(2, { head_sha: "rerun-sha" })]),
        "owner",
        "repo",
        "current-sha",
        ["Tests"],
      ),
    ).resolves.toBe(false);
  });

  test("ignores old failures and the current pull request", async () => {
    await expect(
      hasSystemicWorkflowFailure(
        runs([
          failedRun(2, {
            created_at: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
          }),
          failedRun(3, { head_sha: "current-sha" }),
        ]),
        "owner",
        "repo",
        "current-sha",
        ["Tests"],
      ),
    ).resolves.toBe(false);
  });
});

describe("CI Steward pull request resolution", () => {
  const listing = (prs: unknown[]) =>
    ({
      rest: { pulls: { list: async () => ({ data: prs }) } },
    }) as any;

  const openPr = (overrides: Record<string, unknown> = {}) => ({
    number: 7,
    state: "open",
    head: { ref: "fix-ci", sha: "abc", repo: { full_name: "owner/repo" } },
    base: { ref: "main" },
    user: { login: "dev" },
    draft: false,
    ...overrides,
  });

  const event = {
    workflow_run: { head_sha: "abc", head_branch: "fix-ci", pull_requests: [] },
  } as any;

  test("resolves the pull request whose head commit the run tested", async () => {
    const pr = await resolvePullRequest(
      listing([openPr()]),
      "owner",
      "repo",
      event,
    );
    expect(pr?.number).toBe(7);
    expect(pr?.baseRef).toBe("main");
  });

  // Matching on branch name alone bound the run to whichever pull request
  // happened to share the name, and then commented on the wrong one.
  test("does not bind to a same-named branch on a different commit", async () => {
    const pr = await resolvePullRequest(
      listing([openPr({ head: { ref: "fix-ci", sha: "different" } })]),
      "owner",
      "repo",
      event,
    );
    expect(pr).toBeUndefined();
  });

  test("picks the matching commit when several pull requests share a branch", async () => {
    const pr = await resolvePullRequest(
      listing([
        openPr({ number: 1, head: { ref: "fix-ci", sha: "stale" } }),
        openPr({ number: 2 }),
      ]),
      "owner",
      "repo",
      event,
    );
    expect(pr?.number).toBe(2);
  });

  test("ignores a pull request that is no longer open", async () => {
    const pr = await resolvePullRequest(
      listing([openPr({ state: "closed" })]),
      "owner",
      "repo",
      event,
    );
    expect(pr).toBeUndefined();
  });
});

describe("CI Steward tool exposure", () => {
  // Job logs are attacker-influenced and permission prompts are disabled, so a
  // diagnosis-only run must not be able to write files or run commands.
  test("withholds the shell and file writers when fixes are disabled", () => {
    const tools = stewardAllowedTools(false);
    for (const tool of ["Execute", "Edit", "Create", "ApplyPatch"]) {
      expect(tools).not.toContain(tool);
    }
    expect(tools).toContain("github_ci___download_job_log");
  });

  test("grants them once the repository has asked for fixes", () => {
    expect(stewardAllowedTools(true)).toContain("Execute");
  });
});

describe("CI Steward protected paths", () => {
  const patterns = [".github/workflows/**", "infra/**"];

  test("flags a change to a protected path", () => {
    expect(
      protectedViolations(patterns, ["src/app.ts", ".github/workflows/ci.yml"]),
    ).toEqual([".github/workflows/ci.yml"]);
  });

  test("leaves ordinary source files alone", () => {
    expect(protectedViolations(patterns, ["src/app.ts"])).toEqual([]);
  });

  test("does not let a single star cross a directory boundary", () => {
    expect(protectedViolations(["infra/*"], ["infra/aws/main.tf"])).toEqual([]);
  });
});

describe("CI Steward check waiting", () => {
  // A check can stay queued forever, and this loop holds a job that carries
  // the app token, the workflow token, and the Factory API key.
  test("gives up instead of polling until the job is killed", async () => {
    let calls = 0;
    const octokit = {
      rest: {
        actions: {
          listWorkflowRunsForRepo: async () => {
            calls += 1;
            return {
              data: {
                workflow_runs: [{ id: 2, name: "CI", status: "queued" }],
              },
            };
          },
        },
      },
    } as any;

    await waitForChecksToFinish(octokit, "owner", "repo", "sha", 1, 0);
    expect(calls).toBe(1);
  });
});

describe("CI Steward config loading", () => {
  test("parses block-style nested config", async () => {
    const config = await load(
      ["workflows:", '  exclude: ["Deploy *"]', "retry:", "  mode: off"].join(
        "\n",
      ),
    );
    expect(config.workflows.exclude).toEqual(["Deploy *"]);
    expect(config.retry.mode).toBe("off");
  });

  test("parses flow-style nested config with unquoted keys", async () => {
    const config = await load(
      'workflows: { exclude: ["Deploy *", "Nightly"] }',
    );
    expect(config.workflows.exclude).toEqual(["Deploy *", "Nightly"]);
  });

  test("falls back instead of crashing when an object slot holds a scalar", async () => {
    const config = await load("workflows: nonsense\nretry: alsononsense");
    expect(config.workflows.exclude).toEqual([]);
    expect(config.retry.mode).toBe("smart");
    expect(config.retry.max_per_job).toBe(1);
  });

  test("coerces comma separated strings into arrays", async () => {
    const config = await load("skip:\n  branches: release/*, hotfix/*");
    expect(config.skip.branches).toEqual(["release/*", "hotfix/*"]);
  });

  test("rejects an unknown retry mode", async () => {
    const config = await load("retry:\n  mode: sometimes");
    expect(config.retry.mode).toBe("smart");
  });

  test("action inputs win over the config file", async () => {
    const config = await load("fix:\n  enabled: false", {
      fix: { enabled: true, max_attempts: 5 },
    });
    expect(config.fix.enabled).toBe(true);
    expect(config.fix.max_attempts).toBe(5);
    expect(config.fix.commit_prefix).toBe("fix(ci): ");
  });

  // The previous hand-rolled parser understood only `key: value` on one line.
  // Both of these silently returned defaults, which reads as success while the
  // limit the author wrote is gone.
  test("parses block sequences instead of dropping them", async () => {
    const config = await load(
      [
        "fix:",
        "  protected_paths:",
        '    - ".github/workflows/**"',
        '    - "infra/**"',
      ].join("\n"),
    );
    expect(config.fix.protected_paths).toEqual([
      ".github/workflows/**",
      "infra/**",
    ]);
  });

  test("keeps a top-level key that follows a nested block", async () => {
    const config = await load(
      ["skip:", "  draft_prs: true", "max_runs_per_pr: 2"].join("\n"),
    );
    expect(config.max_runs_per_pr).toBe(2);
  });

  test("reads a block scalar as its text rather than as the pipe", async () => {
    const config = await load(
      ["instructions: |", "  Be careful.", "  Never touch infra."].join("\n"),
    );
    expect(config.instructions).toContain("Never touch infra.");
  });

  // Falling back to defaults on malformed input can quietly widen permissions,
  // so an unparseable file has to stop the run instead.
  test("refuses to run on a malformed config file", async () => {
    await expect(
      load("fix:\n  enabled: true\n bad indent: ["),
    ).rejects.toThrow();
  });

  test("uses defaults when the config file is absent", async () => {
    const octokit = {
      rest: {
        repos: {
          getContent: async () => {
            throw new Error("404");
          },
        },
      },
    } as any;
    const config = await loadStewardConfig(
      octokit,
      "owner",
      "repo",
      "main",
      ".github/droid-ci.yml",
      {},
    );
    expect(config).toEqual(defaultStewardConfig());
  });
});

describe("CI Steward action config", () => {
  test("treats maxRetries=0 as an explicit override, not unset", () => {
    const config = buildActionConfig({ maxRetries: 0 });
    expect(config.retry).toEqual({ max_per_job: 0 });
  });

  test("does not install a retry override for the default maxRetries", () => {
    const config = buildActionConfig({ maxRetries: 1 });
    expect(config.retry).toBeUndefined();
  });

  test("does not install a retry override when maxRetries is absent", () => {
    const config = buildActionConfig({});
    expect(config.retry).toBeUndefined();
  });

  test("installs a retry override for retryMode off", () => {
    const config = buildActionConfig({ retryMode: "off" });
    expect(config.retry).toEqual({ mode: "off" });
  });
});

describe("CI Steward fix scope", () => {
  const check = (job: string, ...steps: string[]) => ({
    workflow: "CI",
    job,
    steps,
  });
  const DEFAULT = ["lint", "types", "tests", "build"];

  // The scope names categories, but repositories name jobs. Matching the
  // configured words literally would switch auto-fix off nearly everywhere.
  test("recognizes the job names repositories actually use", () => {
    expect(checkCategories(check("unit"))).toContain("tests");
    expect(checkCategories(check("typecheck"))).toContain("types");
    expect(checkCategories(check("eslint"))).toContain("lint");
    expect(checkCategories(check("build-and-push"))).toContain("build");
  });

  test("reads the failing step when the job name says nothing", () => {
    expect(checkMatchesScope(DEFAULT, check("ci", "Run bun test"))).toBe(true);
    expect(checkMatchesScope(DEFAULT, check("ci", "Run bun run lint"))).toBe(
      true,
    );
  });

  test("holds a deployment failure outside the default scope", () => {
    expect(checkMatchesScope(DEFAULT, check("deploy-staging"))).toBe(false);
    expect(
      checkMatchesScope(DEFAULT, check("publish", "Run npm publish")),
    ).toBe(false);
  });

  test("honors a narrowed scope", () => {
    expect(checkMatchesScope(["lint"], check("unit", "Run bun test"))).toBe(
      false,
    );
    expect(checkMatchesScope(["lint"], check("lint"))).toBe(true);
  });

  test("matches an unknown scope entry on its own name", () => {
    expect(checkMatchesScope(["docs"], check("docs-build"))).toBe(true);
  });

  // A word must not match because a category name happens to sit inside it.
  test("does not match a category buried in an unrelated word", () => {
    expect(checkMatchesScope(["tests"], check("latest-release"))).toBe(false);
    expect(checkMatchesScope(["build"], check("rebuild-cache"))).toBe(false);
  });

  test("keeps only the failing checks that are in scope", () => {
    const failed = [
      check("deploy-staging"),
      check("unit", "Run bun test"),
      check("lint"),
    ];
    expect(checksInScope(DEFAULT, failed).map((c) => c.job)).toEqual([
      "unit",
      "lint",
    ]);
    expect(checksInScope(["lint"], failed).map((c) => c.job)).toEqual(["lint"]);
    expect(checksInScope(DEFAULT, [check("deploy-staging")])).toEqual([]);
  });
});

describe("CI Steward fix scope, step names", () => {
  const check = (job: string, ...steps: string[]) => ({
    workflow: "CI",
    job,
    steps,
  });
  const DEFAULT = ["lint", "types", "tests", "build"];

  // Caught live: a deploy job whose failing step was called "Push preview
  // bundle" matched the build category on the word "bundle" and was handed
  // the editing tools. Prose step names are not evidence of a category.
  test("ignores a human-written step name", () => {
    expect(
      checkMatchesScope(
        DEFAULT,
        check("deploy-preview", "Push preview bundle"),
      ),
    ).toBe(false);
    expect(
      checkMatchesScope(DEFAULT, check("release", "Compile release notes")),
    ).toBe(false);
  });

  // GitHub names an unnamed run step after its command, which is evidence.
  test("still reads a step GitHub named after the command", () => {
    expect(checkMatchesScope(DEFAULT, check("ci", "Run bun test"))).toBe(true);
    expect(checkMatchesScope(DEFAULT, check("ci", "Run npm run build"))).toBe(
      true,
    );
    expect(checkMatchesScope(DEFAULT, check("ci", "Run ./deploy.sh"))).toBe(
      false,
    );
  });
});
