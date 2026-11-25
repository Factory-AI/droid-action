import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import * as core from "@actions/core";
import { initializeReviewConfig } from "../../src/prepare/review-config";
import { createMockContext } from "../mockContext";

const BASE = "a".repeat(40);
const ENV = [
  "AUTOMATIC_REVIEW",
  "AUTOMATIC_SECURITY_REVIEW",
  "DEFAULT_AUTOMATIC_REVIEW",
];

/** A PR whose base commit holds `reviewYaml` as .factory/review.yaml, or no file. */
function client(reviewYaml?: string) {
  return {
    rest: {
      pulls: { get: async () => ({ data: { base: { sha: BASE } } }) },
      repos: {
        getContent: async () => {
          if (reviewYaml === undefined)
            throw Object.assign(new Error("missing"), { status: 404 });
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(reviewYaml).toString("base64"),
            },
          };
        },
      },
      git: {
        getTree: async ({ tree_sha }: { tree_sha: string }) => ({
          data: {
            truncated: false,
            tree:
              tree_sha === BASE
                ? [
                    {
                      path: ".factory",
                      type: "tree",
                      mode: "040000",
                      sha: "c".repeat(40),
                    },
                  ]
                : [{ path: "review.yaml", type: "blob", mode: "100644" }],
          },
        }),
      },
    },
  };
}

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
  spyOn(core, "exportVariable").mockImplementation(() => {});
  spyOn(core, "setOutput").mockImplementation(() => {});
});
afterEach(() => {
  mock.restore();
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

async function automaticReviews(
  env: Record<string, string>,
  reviewYaml?: string,
) {
  Object.assign(process.env, env);
  const context = createMockContext({
    isPR: true,
    entityNumber: 7,
    inputs: {},
  });
  await initializeReviewConfig(context, client(reviewYaml));
  return {
    code: context.inputs.automaticReview,
    security: context.inputs.automaticSecurityReview,
  };
}

describe("automatic review precedence for github/run-review.sh", () => {
  const script = { DEFAULT_AUTOMATIC_REVIEW: "true" };
  it.each([
    [
      "the caller turns it off",
      { AUTOMATIC_REVIEW: "false" },
      undefined,
      { code: false, security: false },
    ],
    [
      "review.yaml turns it off and the caller leaves it unset",
      {},
      "auto_review:\n  enabled: false\n",
      { code: false, security: false },
    ],
    ["neither sets it", {}, undefined, { code: true, security: true }],
    [
      "review.yaml sets other settings only",
      {},
      "review_depth: shallow\n",
      { code: true, security: true },
    ],
    [
      "the caller asks for a security-only review",
      { AUTOMATIC_REVIEW: "false", AUTOMATIC_SECURITY_REVIEW: "true" },
      undefined,
      { code: false, security: true },
    ],
    [
      "review.yaml asks for a security-only review",
      {},
      "auto_review:\n  enabled: false\n  security: true\n",
      { code: false, security: true },
    ],
    [
      "the caller turns it on over review.yaml",
      { AUTOMATIC_REVIEW: "true" },
      "auto_review:\n  enabled: false\n",
      { code: true, security: true },
    ],
  ])("%s", async (_case, env, reviewYaml, expected) => {
    expect(await automaticReviews({ ...script, ...env }, reviewYaml)).toEqual(
      expected,
    );
  });

  it("leaves automatic review opt-in in Actions, which never sets the default", async () => {
    expect(await automaticReviews({})).toEqual({
      code: false,
      security: false,
    });
  });
});
