import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import {
  createOctokit,
  withRequestRedaction,
} from "../../../src/github/api/client";
import {
  redactCredentialPatterns,
  redactCredentials,
  redactSecrets,
} from "../../../src/utils/redact-credentials";

const TOKEN = `ghs_${"B".repeat(36)}`;
// Matches no token format, so only exact-value redaction can catch it.
const FACTORY_KEY = "factory-key-value-abcdefghijklmnop";
const OTHER_PAT = `ghp_${"C".repeat(36)}`;
const LEAKY_TEXT = `token ${TOKEN} key ${FACTORY_KEY} pat ${OTHER_PAT}`;

type CapturedRequest = {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
};

describe("canonical credential quote preservation", () => {
  const secret = "fixture-sensitive-value";
  for (const scheme of ["Basic", "Bearer"]) {
    for (const quote of ["'", '"']) {
      test(`${scheme}: preserves outer shell and value quote delimiters ${quote}`, () => {
        const cases = [
          [
            `curl -H ${quote}Authorization: ${scheme} ${secret}${quote}`,
            `curl -H ${quote}Authorization: ${scheme} [REDACTED]${quote}`,
          ],
          [
            `Authorization: ${scheme} ${quote}${secret}${quote}`,
            `Authorization: ${scheme} ${quote}[REDACTED]${quote}`,
          ],
          [
            `Authorization: ${quote}${scheme} ${secret}${quote}`,
            `Authorization: ${quote}${scheme} [REDACTED]${quote}`,
          ],
          [
            `Authorization: ${quote}${scheme} ${secret} with spaces${quote}`,
            `Authorization: ${quote}${scheme} [REDACTED]${quote}`,
          ],
          [
            `Authorization: ${quote}${scheme} ${secret}`,
            `Authorization: ${quote}${scheme} [REDACTED]`,
          ],
        ];
        for (const [raw, expected] of cases) {
          const actual = redactCredentialPatterns(raw!);
          expect(actual).toBe(expected!);
          expect(actual).not.toContain(secret);
          expect(redactCredentialPatterns(actual)).toBe(actual);
        }
      });
    }
  }
  for (const name of [
    "FACTORY_API_KEY",
    "APP_PRIVATE_KEY",
    "password",
    "secret",
  ]) {
    for (const quote of ["'", '"']) {
      test(`${name}: preserves quoted assignment delimiters ${quote}`, () => {
        for (const [raw, expected] of [
          [
            `${name}=${quote}${secret}${quote}`,
            `${name}=${quote}[REDACTED]${quote}`,
          ],
          [
            `${name}=${quote}${secret} with spaces${quote}`,
            `${name}=${quote}[REDACTED]${quote}`,
          ],
          [`${name}=${quote}${secret}`, `${name}=${quote}[REDACTED]`],
          [`'${name}=${secret}'`, `'${name}=[REDACTED]'`],
        ]) {
          const actual = redactCredentialPatterns(raw!);
          expect(actual).toBe(expected!);
          expect(actual).not.toContain(secret);
          expect(redactCredentialPatterns(actual)).toBe(actual);
        }
      });
    }
  }
  for (const quote of ["'", '"']) {
    for (const prefix of [
      "password=",
      "Authorization: Basic ",
      "Authorization: ",
    ]) {
      for (const slashes of [1, 2, 3, 4]) {
        test(`escape-aware quoted ${prefix} delimiter ${quote}, backslashes=${slashes}`, () => {
          const scheme = prefix === "Authorization: " ? "Bearer " : "";
          const credential =
            slashes % 2
              ? `alpha${"\\".repeat(slashes)}${quote}omega`
              : `alpha${"\\".repeat(slashes)}`;
          const suffix = ', "safe": "visible"';
          const raw = `${prefix}${quote}${scheme}${credential}${quote}${suffix}`;
          const actual = redactCredentialPatterns(raw);
          expect(actual).toBe(
            `${prefix}${quote}${scheme}[REDACTED]${quote}${suffix}`,
          );
          expect(actual).not.toContain("alpha");
          expect(actual).not.toContain("omega");
          expect(redactCredentialPatterns(actual)).toBe(actual);
        });
      }
      test(`masks an unclosed quoted ${prefix} value ending in a backslash ${quote}`, () => {
        const scheme = prefix === "Authorization: " ? "Bearer " : "";
        const raw = `${prefix}${quote}${scheme}alpha\\\nnext_safe_field=visible`;
        const actual = redactCredentialPatterns(raw);
        expect(actual).toBe(
          `${prefix}${quote}${scheme}[REDACTED]\nnext_safe_field=visible`,
        );
        expect(actual).not.toContain("alpha");
        expect(redactCredentialPatterns(actual)).toBe(actual);
      });
    }
  }
  test("keeps exact-secret-first redaction and canonical token placeholders idempotent", () => {
    const raw = `curl -H 'Authorization: Basic ${secret}'`;
    expect(redactSecrets(raw, [secret])).toBe(
      "curl -H 'Authorization: Basic [REDACTED]'",
    );
    expect(
      redactCredentials(`APP_PRIVATE_KEY="${secret}"`, {
        APP_PRIVATE_KEY: secret,
      }),
    ).toBe('APP_PRIVATE_KEY="[REDACTED]"');
    const token = `ghs_${"Z".repeat(36)}`;
    expect(redactCredentialPatterns(token)).toBe("[REDACTED_GITHUB_TOKEN]");
    expect(redactCredentialPatterns(redactCredentialPatterns(token))).toBe(
      "[REDACTED_GITHUB_TOKEN]",
    );
  });
});

describe("canonical credential JSONL separator preservation", () => {
  test("keeps adjacent exact-redacted assignments and JSONL formatting byte-for-byte", () => {
    const raw =
      '{"output":"GITHUB_TOKEN=unknownAlpha\\nFACTORY_API_KEY=unknownOmega"}\n';
    expect(redactSecrets(raw, ["unknownAlpha", "unknownOmega"])).toBe(
      '{"output":"GITHUB_TOKEN=[REDACTED]\\nFACTORY_API_KEY=[REDACTED]"}\n',
    );
  });
  for (const separator of [
    String.raw`\n`,
    String.raw`\r`,
    String.raw`\t`,
    String.raw`\r\n`,
  ]) {
    for (const [first, second] of [
      ["GITHUB_TOKEN=", "FACTORY_API_KEY="],
      ["Authorization: Basic ", "password="],
      ["password=", "Authorization: Bearer "],
      ["Authorization: Bearer ", "Authorization: Basic "],
    ]) {
      test(`masks both unknown fields without exact secrets across ${separator}: ${first} then ${second}`, () => {
        const raw = `{"output":"${first}unknownAlpha${separator}${second}unknownOmega"}\n`;
        const expected = `{"output":"${first}[REDACTED]${separator}${second}[REDACTED]"}\n`;
        const actual = redactSecrets(raw, []);
        expect(actual).toBe(expected);
        expect(actual).not.toContain("unknownAlpha");
        expect(actual).not.toContain("unknownOmega");
        expect(redactCredentialPatterns(actual)).toBe(actual);
      });
    }
  }
  for (const separatorEnd of ["n", "r", "t", String.raw`r\n`]) {
    for (const slashes of [1, 2, 3, 4]) {
      test(`keeps auth-to-auth continuation masked with ${slashes} backslashes before ${separatorEnd}`, () => {
        const raw = `Authorization: Basic unknownAlpha${"\\".repeat(slashes)}${separatorEnd}Authorization: Bearer unknownOmega`;
        const retainedSeparator =
          slashes % 2
            ? `\\${separatorEnd}`
            : separatorEnd === String.raw`r\n`
              ? String.raw`\n`
              : "";
        const expected = retainedSeparator
          ? `Authorization: Basic [REDACTED]${retainedSeparator}Authorization: Bearer [REDACTED]`
          : "Authorization: Basic [REDACTED]";
        const actual = redactSecrets(raw, []);
        expect(actual).toBe(expected);
        expect(actual).not.toContain("unknownAlpha");
        expect(actual).not.toContain("unknownOmega");
        expect(redactCredentialPatterns(actual)).toBe(actual);
      });
    }
  }
  for (const quote of ["'", '"']) {
    for (const continuation of [
      `Authorization: ${quote}Bearer unknownOmega`,
      `Authorization: Basic ${quote}unknownOmega`,
      `password = ${quote}unknownOmega`,
    ]) {
      test(`masks unclosed even-run quoted continuation through line end: ${continuation}`, () => {
        const raw = `password=unknownAlpha\\\\n${continuation}\\\nnext_safe_field=visible`;
        const actual = redactSecrets(raw, []);
        expect(actual).toBe("password=[REDACTED]\nnext_safe_field=visible");
        expect(actual).not.toContain("unknownAlpha");
        expect(actual).not.toContain("unknownOmega");
        expect(redactCredentialPatterns(actual)).toBe(actual);
      });
    }
    for (const continuation of [
      `Authorization: ${quote}Bearer unknownOmega${quote}`,
      `Authorization: Basic ${quote}unknownOmega${quote}`,
      `password = ${quote}unknownOmega${quote}`,
      "password = unknownOmega",
    ]) {
      test(`masks even-run recognized continuation and leaves safe adjacent fields: ${continuation}`, () => {
        const suffix = ", safe=visible";
        const raw = `password=unknownAlpha\\\\n${continuation}${suffix}`;
        const actual = redactSecrets(raw, []);
        expect(actual).toBe(`password=[REDACTED]${suffix}`);
        expect(actual).not.toContain("unknownAlpha");
        expect(actual).not.toContain("unknownOmega");
        expect(redactCredentialPatterns(actual)).toBe(actual);
      });
    }
  }
  test("does not cross an actual line break when masking an embedded field prefix", () => {
    const raw =
      "password=unknownAlpha\\\\nAuthorization:\nnext_safe_field=visible";
    expect(redactCredentialPatterns(raw)).toBe(
      "password=[REDACTED]\nnext_safe_field=visible",
    );
  });
  for (const newline of ["\n", "\r\n"]) {
    test(`preserves safe fields after an empty authorization header across ${JSON.stringify(newline)}`, () => {
      const raw = `Authorization:${newline}next_safe_field=visible`;
      expect(redactCredentialPatterns(raw)).toBe(raw);
      const embedded = `password=unknownAlpha\\\\nAuthorization:${newline}next_safe_field=visible`;
      expect(redactCredentialPatterns(embedded)).toBe(
        `password=[REDACTED]${newline}next_safe_field=visible`,
      );
    });
    test(`does not extend a quoted authorization scheme over ${JSON.stringify(newline)}`, () => {
      const raw = `Authorization: "Bearer${newline}next_safe_field=visible`;
      const actual = redactCredentialPatterns(raw);
      expect(actual).toBe(
        `Authorization: "[REDACTED]${newline}next_safe_field=visible`,
      );
      expect(redactCredentialPatterns(actual)).toBe(actual);
    });
  }
  for (const first of ["password=", "Authorization: Basic "]) {
    for (const slashes of [1, 2, 3, 4]) {
      test(`retains even backslash pairs inside unknown ${first} values, slashes=${slashes}`, () => {
        const separator = `${"\\".repeat(slashes)}n`;
        const raw = `${first}unknownAlpha${separator}FACTORY_API_KEY=unknownOmega`;
        const actual = redactCredentialPatterns(raw);
        expect(actual).toBe(
          slashes % 2
            ? `${first}[REDACTED]\\nFACTORY_API_KEY=[REDACTED]`
            : `${first}[REDACTED]`,
        );
        expect(actual).not.toContain("unknownAlpha");
        expect(actual).not.toContain("unknownOmega");
        expect(redactCredentialPatterns(actual)).toBe(actual);
      });
    }
    for (const suffix of [
      String.raw`alpha\omega`,
      String.raw`alpha\nordinarySuffix`,
      String.raw`alpha\runknown_field=omega`,
      String.raw`alpha\\nFACTORY_API_KEY=omega`,
      "alpha\\",
    ]) {
      test(`does not expose arbitrary backslash credential suffixes: ${first}${suffix}`, () => {
        const actual = redactCredentialPatterns(`${first}${suffix}`);
        expect(actual).toBe(`${first}[REDACTED]`);
        expect(actual).not.toContain("alpha");
        expect(actual).not.toContain("omega");
        expect(redactCredentialPatterns(actual)).toBe(actual);
      });
    }
  }
});

describe("GitHub client request redaction", () => {
  let requests: CapturedRequest[];
  let fetchSpy: ReturnType<typeof spyOn>;
  const originalKey = process.env.FACTORY_API_KEY;

  beforeEach(() => {
    requests = [];
    process.env.FACTORY_API_KEY = FACTORY_KEY;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: unknown,
      init?: RequestInit,
    ) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
        headers: Object.fromEntries(
          new Headers(
            init?.headers as ConstructorParameters<typeof Headers>[0],
          ).entries(),
        ),
      });
      return new Response(JSON.stringify({ id: 1, data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (originalKey === undefined) delete process.env.FACTORY_API_KEY;
    else process.env.FACTORY_API_KEY = originalKey;
  });

  function expectRedacted(body: string) {
    expect(body).toContain("[REDACTED");
    for (const secret of [TOKEN, FACTORY_KEY, OTHER_PAT]) {
      expect(body).not.toContain(secret);
    }
  }

  test("redacts comment bodies", async () => {
    const { rest } = createOctokit(TOKEN);
    await rest.issues.createComment({
      owner: "o",
      repo: "r",
      issue_number: 1,
      body: LEAKY_TEXT,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expectRedacted(requests[0]!.body);
    // The credential the request authenticates with is left intact.
    expect(requests[0]!.headers.authorization).toContain(TOKEN);
  });

  test("redacts review comments nested in arrays", async () => {
    const { rest } = createOctokit(TOKEN);
    await rest.pulls.createReview({
      owner: "o",
      repo: "r",
      pull_number: 1,
      event: "COMMENT",
      body: "summary",
      comments: [{ path: "a.ts", line: 1, body: LEAKY_TEXT }],
    });

    expectRedacted(requests[0]!.body);
    expect(JSON.parse(requests[0]!.body).comments[0].path).toBe("a.ts");
  });

  test("redacts updates to PR descriptions and comments", async () => {
    const { rest } = createOctokit(TOKEN);
    await rest.pulls.update({
      owner: "o",
      repo: "r",
      pull_number: 1,
      body: LEAKY_TEXT,
    });
    await rest.issues.updateComment({
      owner: "o",
      repo: "r",
      comment_id: 2,
      body: LEAKY_TEXT,
    });

    expect(requests.map((r) => r.method)).toEqual(["PATCH", "PATCH"]);
    for (const request of requests) expectRedacted(request.body);
  });

  test("redacts GraphQL variables", async () => {
    const { graphql } = createOctokit(TOKEN);
    await graphql(
      `
        mutation ($threadId: ID!, $body: String!) {
          addPullRequestReviewThreadReply(
            input: { pullRequestReviewThreadId: $threadId, body: $body }
          ) {
            clientMutationId
          }
        }
      `,
      { threadId: "T_1", body: LEAKY_TEXT },
    );

    expectRedacted(requests[0]!.body);
    expect(JSON.parse(requests[0]!.body).variables.threadId).toBe("T_1");
    expect(requests[0]!.headers.authorization).toContain(TOKEN);
  });

  test("covers a standalone Octokit, its GraphQL client included", async () => {
    const octokit = withRequestRedaction(new Octokit({ auth: TOKEN }), TOKEN);
    await octokit.rest.issues.createComment({
      owner: "o",
      repo: "r",
      issue_number: 1,
      body: LEAKY_TEXT,
    });
    await octokit.graphql(`mutation ($body: String!) { x(body: $body) }`, {
      body: LEAKY_TEXT,
    });

    expect(requests).toHaveLength(2);
    for (const request of requests) expectRedacted(request.body);
  });
});
