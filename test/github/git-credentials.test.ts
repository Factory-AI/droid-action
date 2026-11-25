import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { git } from "../helpers/git";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const WRITE_TOKEN = "ghs_write_token";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Answers `get` with GH_TOKEN, as `gh auth git-credential` does. */
const GH_STUB = `#!/usr/bin/env bash
if [ "$1 $2 $3" = "auth git-credential get" ]; then
  echo username=x-access-token
  echo "password=$GH_TOKEN"
fi
`;

/** A smart-HTTP git server that, like GitHub, wants credentials. */
function startGitServer(projectRoot: string) {
  const credentials: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const auth = req.headers.get("authorization");
      if (!auth)
        return new Response("", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="git"' },
        });
      credentials.push(Buffer.from(auth.slice(6), "base64").toString());
      const url = new URL(req.url);
      const backend = Bun.spawn(["git", "http-backend"], {
        env: {
          PATH: process.env.PATH!,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers.get("content-type") ?? "",
          HTTP_CONTENT_ENCODING: req.headers.get("content-encoding") ?? "",
        },
        stdin: new Blob([await req.arrayBuffer()]),
        stdout: "pipe",
      });
      const output = Buffer.from(
        await new Response(backend.stdout).arrayBuffer(),
      );
      const end = output.indexOf("\r\n\r\n");
      const headers = new Headers();
      let status = 200;
      for (const line of output.subarray(0, end).toString().split("\r\n")) {
        const [name = "", value = ""] = line.split(": ");
        if (name === "Status") status = Number.parseInt(value);
        else headers.set(name, value);
      }
      return new Response(output.subarray(end + 4), { status, headers });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    credentials,
    stop: () => server.stop(true),
  };
}

describe("authenticated git fetches on a computer with credential.helper=store", () => {
  it("use the token without storing it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-cred-"));
    dirs.push(root);
    const projects = path.join(root, "projects");
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    git(work, "init", "-q", "-b", "main");
    git(work, "config", "user.email", "test@example.com");
    git(work, "config", "user.name", "Test");
    // Two commits, so a depth-1 clone is shallow.
    for (const content of ["one\n", "two\n"]) {
      fs.writeFileSync(path.join(work, "app.ts"), content);
      git(work, "add", ".");
      git(work, "commit", "-qm", content.trim());
    }
    fs.mkdirSync(path.join(projects, "acme"), { recursive: true });
    git(
      root,
      "clone",
      "-q",
      "--bare",
      work,
      path.join(projects, "acme/app.git"),
    );

    const home = path.join(root, "home");
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(home, ".gitconfig"),
      "[credential]\n\thelper = store\n",
    );
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "gh"), GH_STUB, { mode: 0o755 });
    const env = {
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_CONFIG_NOSYSTEM: "1",
    };

    const server = startGitServer(projects);
    try {
      const checkout = path.join(root, "checkout");
      const clone = spawnSync(
        "git",
        [
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!f() { echo username=computer; echo password=read-token; }; f",
          "clone",
          "-q",
          "--depth",
          "1",
          `${server.url}/acme/app.git`,
          checkout,
        ],
        { env, encoding: "utf8" },
      );
      expect(clone.stderr).toBe("");

      // The diff step of before: `fetch --unshallow`, then the base branch.
      const diff = spawnSync(
        "bun",
        [
          "-e",
          `const { computeAndStoreDiff } = await import(${JSON.stringify(path.join(REPO_ROOT, "src/github/data/review-artifacts.ts"))});
await computeAndStoreDiff("main", ${JSON.stringify(root)}, { githubToken: ${JSON.stringify(WRITE_TOKEN)}, prNumber: 7 });`,
        ],
        { cwd: checkout, env, encoding: "utf8" },
      );
      expect(diff.status).toBe(0);
      expect(git(checkout, "rev-parse", "--is-shallow-repository")).toBe(
        "false",
      );
    } finally {
      server.stop();
    }
    expect(server.credentials).toContain(`x-access-token:${WRITE_TOKEN}`);
    const store = path.join(home, ".git-credentials");
    expect(
      fs.existsSync(store) ? fs.readFileSync(store, "utf8") : "",
    ).not.toContain(WRITE_TOKEN);
  });
});
