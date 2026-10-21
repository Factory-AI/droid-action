import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type RecordedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

type Route = {
  method: string;
  match: (url: URL) => boolean;
  respond: (req: RecordedRequest, url: URL) => Response;
};

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

/**
 * Fake `fetch` that records every request and answers from registered
 * routes. Unmatched requests fail the test loudly with a 599.
 */
export function createFakeAdo() {
  const requests: RecordedRequest[] = [];
  const routes: Route[] = [];

  const fetch = async (input: string, init: RequestInit = {}) => {
    const headers = { ...(init.headers as Record<string, string>) };
    const raw = typeof init.body === "string" ? init.body : undefined;
    const req: RecordedRequest = {
      method: init.method ?? "GET",
      url: input,
      headers,
      body: raw === undefined ? undefined : JSON.parse(raw),
    };
    requests.push(req);
    const url = new URL(input);
    const route = routes.find((r) => r.method === req.method && r.match(url));
    if (!route) {
      return new Response(`no route for ${req.method} ${input}`, {
        status: 599,
      });
    }
    return route.respond(req, url);
  };

  const on = (
    method: string,
    pathSuffix: string | RegExp,
    respond: Route["respond"],
  ) => {
    routes.push({
      method,
      match: (url) =>
        typeof pathSuffix === "string"
          ? url.pathname.endsWith(pathSuffix)
          : pathSuffix.test(url.pathname),
      respond,
    });
  };

  return { fetch, requests, on };
}

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * A repo shaped like an Azure Pipelines PR checkout: `main` moved on after
 * the feature branch forked, and HEAD is the PR merge commit.
 */
export function createPrRepo() {
  const dir = tempDir("ado-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "app.ts"), "line1\nline2\nline3\n");
  fs.writeFileSync(path.join(dir, "old.ts"), "remove me\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  const common = git(dir, "rev-parse", "HEAD");

  git(dir, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(
    path.join(dir, "app.ts"),
    "line1\nline2 changed\nline3\nline4\n",
  );
  fs.rmSync(path.join(dir, "old.ts"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "feature");
  const source = git(dir, "rev-parse", "HEAD");

  git(dir, "checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "main-only.ts"), "target change\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "main moved");
  const target = git(dir, "rev-parse", "HEAD");

  git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feature");
  const merge = git(dir, "rev-parse", "HEAD");
  return { dir, common, source, target, merge };
}

export const SERVICES_ENV = {
  SYSTEM_COLLECTIONURI: "https://dev.azure.com/contoso/",
  SYSTEM_TEAMPROJECT: "Fabrikam Web",
  SYSTEM_TEAMPROJECTID: "6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c",
  BUILD_REPOSITORY_ID: "3411ebc1-d5aa-464f-9615-0b527bc66719",
  BUILD_REPOSITORY_NAME: "web-app",
  BUILD_REPOSITORY_PROVIDER: "TfsGit",
  BUILD_REASON: "PullRequest",
  BUILD_BUILDID: "4521",
  BUILD_BUILDNUMBER: "20261019.3",
  SYSTEM_JOBID: "12f1170f-54f2-53f3-20dd-22fc7dff55f9",
  SYSTEM_JOBATTEMPT: "1",
  SYSTEM_PULLREQUEST_PULLREQUESTID: "17",
  SYSTEM_PULLREQUEST_SOURCEBRANCH: "refs/heads/feature",
  SYSTEM_PULLREQUEST_TARGETBRANCH: "refs/heads/main",
  SYSTEM_PULLREQUEST_ISFORK: "False",
  BUILD_REQUESTEDFOR: "Ada Lovelace",
  BUILD_REQUESTEDFOREMAIL: "ada@contoso.com",
  SYSTEM_ACCESSTOKEN: "job-token-secret",
} as const;
