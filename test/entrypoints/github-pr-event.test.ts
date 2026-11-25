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

describe("github-pr-event with PR_HEAD_WAIT_SECONDS", () => {
  const OLD = "b".repeat(40);
  const NEW = PR.head.sha;
  const NEWER = "c".repeat(40);

  /**
   * Serves the PR with the next of `heads` on each read (then the last one),
   * and the compare status `statuses` gives for base...head, or a 404.
   */
  async function readEvent(
    heads: string[],
    statuses: Record<string, string>,
    waitSeconds?: string,
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-event-"));
    dirs.push(dir);
    let reads = 0;
    const server = startFakeServer((_req, url) => {
      if (url.pathname === "/repos/acme/app/pulls/7") {
        const sha = heads[Math.min(reads++, heads.length - 1)];
        return json({ ...PR, head: { ...PR.head, sha } });
      }
      const status = statuses[url.pathname.split("/compare/")[1] ?? ""];
      return status ? json({ status }) : json({ message: "Not Found" }, 404);
    });
    const env = {
      GITHUB_API_URL: server.url,
      GITHUB_REPOSITORY: "acme/app",
      PR_NUMBER: "7",
      PR_ACTION: "synchronize",
      PR_HEAD_SHA: NEW,
      GITHUB_TOKEN: "ghs_token",
      GITHUB_EVENT_PATH: path.join(dir, "event.json"),
      GITHUB_OUTPUT: path.join(dir, "outputs"),
      ...(waitSeconds ? { PR_HEAD_WAIT_SECONDS: waitSeconds } : {}),
    };
    fs.writeFileSync(env.GITHUB_OUTPUT, "");
    let run;
    try {
      run = await bun(["run", "src/entrypoints/github-pr-event.ts"], env);
    } finally {
      server.stop();
    }
    expect(run.status).toBe(0);
    const outputs = fs.readFileSync(env.GITHUB_OUTPUT, "utf8");
    return {
      head: /^head_sha<<(.+)\n([0-9a-f]+)\n\1$/m.exec(outputs)?.[2],
      eventHead: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
        .pull_request.head.sha,
      reads,
    };
  }

  it("reads the PR again while GitHub still reports the previous head", async () => {
    const event = await readEvent(
      [OLD, NEW],
      { [`${NEW}...${OLD}`]: "behind" },
      "30",
    );
    expect(event).toEqual({ head: NEW, eventHead: NEW, reads: 2 });
  });

  it("returns at once when the PR moved past PR_HEAD_SHA", async () => {
    const event = await readEvent(
      [NEWER, NEW],
      { [`${NEW}...${NEWER}`]: "ahead" },
      "3",
    );
    expect(event).toEqual({ head: NEWER, eventHead: NEWER, reads: 1 });
  });

  it("stops reading once PR_HEAD_WAIT_SECONDS has passed", async () => {
    // GitHub does not know NEW at all: the compare is a 404.
    const event = await readEvent([OLD], {}, "1");
    expect(event.head).toBe(OLD);
    expect(event.reads).toBe(2);
  });

  it("does not wait without PR_HEAD_WAIT_SECONDS", async () => {
    const event = await readEvent([OLD, NEW], {
      [`${NEW}...${OLD}`]: "behind",
    });
    expect(event).toEqual({ head: OLD, eventHead: OLD, reads: 1 });
  });
});
