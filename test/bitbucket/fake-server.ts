/**
 * A real local HTTP server for Bitbucket client tests. Every request is
 * recorded (method, path with query, headers, parsed body) so tests can
 * assert on exactly what went over the wire.
 */

import type { DcDiff } from "../../src/bitbucket/api/datacenter";

export type RecordedRequest = {
  method: string;
  /** Pathname plus query string. */
  path: string;
  headers: Record<string, string>;
  body: any;
};

export type FakeServer = {
  url: string;
  requests: RecordedRequest[];
  stop: () => void;
};

export function startFakeServer(
  handler: (req: RecordedRequest, url: URL) => Response | Promise<Response>,
): FakeServer {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const recorded: RecordedRequest = {
        method: req.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      };
      requests.push(recorded);
      return handler(recorded, url);
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export const notFound = () => json({ error: "no route" }, 404);

/** Sample diff shared by the posting tests. Line roles:
 *  new 1 ctx(old 1), new 2-3 added, new 4 ctx(old 3), new 5 ctx(old 4);
 *  old 2 removed. */
export const APP_TS_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " export { a };",
  " export { b };",
  "",
].join("\n");

/** Data Center's structured diff for the same change as APP_TS_DIFF. */
export const APP_TS_DC_DIFF: DcDiff = {
  source: { toString: "src/app.ts" },
  destination: { toString: "src/app.ts" },
  hunks: [
    {
      sourceLine: 1,
      sourceSpan: 4,
      destinationLine: 1,
      destinationSpan: 5,
      segments: [
        {
          type: "CONTEXT",
          lines: [{ source: 1, destination: 1, line: "const a = 1;" }],
        },
        {
          type: "REMOVED",
          lines: [{ source: 2, destination: 2, line: "const b = 2;" }],
        },
        {
          type: "ADDED",
          lines: [
            { source: 3, destination: 2, line: "const b = 3;" },
            { source: 3, destination: 3, line: "const c = 4;" },
          ],
        },
        {
          type: "CONTEXT",
          lines: [
            { source: 3, destination: 4, line: "export { a };" },
            { source: 4, destination: 5, line: "export { b };" },
          ],
        },
      ],
    },
  ],
};
