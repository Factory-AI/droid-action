import { describe, expect, it, spyOn } from "bun:test";
import { GitlabClient } from "../../src/gitlab/api/client";

describe("GitLab Retry-After contract", () => {
  for (const hint of ["30", "Tue, 14 Nov 2023 22:13:50 GMT"])
    it(`waits for the server hint on GET: ${hint}`, async () => {
      let now = 1700000000000;
      const attempts: number[] = [];
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: () => void,
        delay: number,
      ) => {
        now += delay;
        queueMicrotask(callback);
        return 0;
      }) as never);
      const implementation = Object.assign(
        async () => {
          attempts.push(now);
          return attempts.length < 3
            ? new Response("limited", {
                status: 429,
                headers: { "Retry-After": hint },
              })
            : Response.json({ id: 1 });
        },
        { preconnect: globalThis.fetch.preconnect },
      );
      const fetch = spyOn(globalThis, "fetch").mockImplementation(
        implementation,
      );
      try {
        await new GitlabClient("fake-token").getCurrentUser();
        expect(attempts).toHaveLength(3);
        expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(30000);
        if (hint === "30")
          expect(attempts[2]! - attempts[1]!).toBeGreaterThanOrEqual(30000);
      } finally {
        fetch.mockRestore();
        timer.mockRestore();
        clock.mockRestore();
      }
    });

  it("never retries a write even when rate limited", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("limited", {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
    );
    try {
      await expect(
        new GitlabClient("fake-token").createNote(42, 7, "safe"),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      fetch.mockRestore();
    }
  });
});
