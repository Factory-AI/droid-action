import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { json, startFakeServer } from "../helpers/fake-server";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const PR = {
  number: 7,
  draft: true,
  title: "Add retries",
  body: "Fixes flaky uploads",
  user: { login: "octocat", type: "User" },
  head: {
    sha: "a".repeat(40),
    ref: "retries",
    repo: { full_name: "acme/app" },
  },
  base: {
    ref: "main",
    repo: { name: "app", full_name: "acme/app", owner: { login: "acme" } },
  },
};

async function bun(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", ...args], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH!, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, status };
}

describe("github-pr-event", () => {
  it("writes a pull_request event the Actions context parser accepts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-event-"));
    dirs.push(dir);
    const server = startFakeServer((req) =>
      req.path === "/repos/acme/app/pulls/7"
        ? json(PR)
        : json({ message: "Not Found" }, 404),
    );
    const env = {
      GITHUB_API_URL: server.url,
      GITHUB_REPOSITORY: "acme/app",
      PR_NUMBER: "7",
      PR_ACTION: "opened",
      GITHUB_TOKEN: "ghs_token",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: path.join(dir, "event.json"),
      GITHUB_OUTPUT: path.join(dir, "outputs"),
    };
    fs.writeFileSync(env.GITHUB_OUTPUT, "");
    try {
      const run = await bun(["run", "src/entrypoints/github-pr-event.ts"], env);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
    } finally {
      server.stop();
    }
    expect(server.requests[0]?.headers.authorization).toBe("token ghs_token");
    const outputs = fs.readFileSync(env.GITHUB_OUTPUT, "utf8");
    expect(outputs).toMatch(
      new RegExp(`^head_sha<<(.+)\\n${"a".repeat(40)}\\n\\1$`, "m"),
    );

    const parsed = await bun(
      [
        "-e",
        'const { parseGitHubContext } = await import("./src/github/context.ts"); const c = parseGitHubContext(); console.log(JSON.stringify({ eventName: c.eventName, eventAction: c.eventAction, repository: c.repository, entityNumber: c.entityNumber, isPR: c.isPR, draft: c.payload.pull_request.draft }));',
      ],
      env,
    );
    expect(parsed.status).toBe(0);
    expect(JSON.parse(parsed.stdout)).toEqual({
      eventName: "pull_request",
      eventAction: "opened",
      repository: { owner: "acme", repo: "app", full_name: "acme/app" },
      entityNumber: 7,
      isPR: true,
      draft: true,
    });
  });
});
