/**
 * A real local HTTP server for client tests. Every request is recorded
 * (method, path with query, headers, parsed body) so tests can assert on
 * exactly what went over the wire.
 */

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
