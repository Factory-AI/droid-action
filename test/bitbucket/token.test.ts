import { describe, expect, it } from "bun:test";
import {
  MissingBitbucketCredentialsError,
  UnexpandedBitbucketTokenError,
  resolveBitbucketAuth,
  withoutBitbucketCredentials,
} from "../../src/bitbucket/token";

describe("resolveBitbucketAuth", () => {
  it("uses Bearer for an access token", () => {
    expect(resolveBitbucketAuth({ DROID_BITBUCKET_TOKEN: " tok " })).toEqual({
      header: "Bearer tok",
    });
  });

  it("uses Basic for username + API token", () => {
    expect(
      resolveBitbucketAuth({
        DROID_BITBUCKET_USERNAME: "dev@example.com",
        DROID_BITBUCKET_API_TOKEN: "secret",
      }),
    ).toEqual({
      header: "Basic ZGV2QGV4YW1wbGUuY29tOnNlY3JldA==",
    });
  });

  it("prefers the access token when both are configured", () => {
    expect(
      resolveBitbucketAuth({
        DROID_BITBUCKET_TOKEN: "tok",
        DROID_BITBUCKET_USERNAME: "u",
        DROID_BITBUCKET_API_TOKEN: "p",
      }).header,
    ).toBe("Bearer tok");
  });

  it("requires both halves of Basic auth", () => {
    expect(() =>
      resolveBitbucketAuth({ DROID_BITBUCKET_API_TOKEN: "p" }),
    ).toThrow(MissingBitbucketCredentialsError);
    expect(() => resolveBitbucketAuth({})).toThrow(
      /Missing Bitbucket credentials/,
    );
  });

  it("refuses unexpanded variable references without echoing secrets", () => {
    const err = (() => {
      try {
        resolveBitbucketAuth({
          DROID_BITBUCKET_TOKEN: "$DROID_BITBUCKET_TOKEN",
        });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(UnexpandedBitbucketTokenError);
    expect(err!.message).toContain('"$DROID_BITBUCKET_TOKEN"');
    expect(() =>
      resolveBitbucketAuth({
        DROID_BITBUCKET_USERNAME: "u",
        DROID_BITBUCKET_API_TOKEN: "${BITBUCKET_API_TOKEN}",
      }),
    ).toThrow(UnexpandedBitbucketTokenError);
  });

  it.each([
    "${bamboo.DROID_BITBUCKET_TOKEN_SECRET}",
    "$(DROID_BITBUCKET_TOKEN)",
  ])("refuses the unexpanded CI reference %s", (value) => {
    expect(() =>
      resolveBitbucketAuth({ DROID_BITBUCKET_TOKEN: value }),
    ).toThrow(UnexpandedBitbucketTokenError);
  });

  it("accepts real tokens that merely contain a dollar sign", () => {
    expect(
      resolveBitbucketAuth({ DROID_BITBUCKET_TOKEN: "abc$def.ghi" }).header,
    ).toBe("Bearer abc$def.ghi");
  });
});

describe("withoutBitbucketCredentials", () => {
  it("drops every credential and keeps the rest", () => {
    const env = {
      DROID_BITBUCKET_TOKEN: "a",
      DROID_BITBUCKET_USERNAME: "b",
      DROID_BITBUCKET_API_TOKEN: "c",
      BITBUCKET_STEP_OIDC_TOKEN: "d",
      FACTORY_API_KEY: "fk",
      BITBUCKET_PR_ID: "1",
    };
    expect(withoutBitbucketCredentials(env)).toEqual({
      FACTORY_API_KEY: "fk",
      BITBUCKET_PR_ID: "1",
    });
    expect(env.DROID_BITBUCKET_TOKEN).toBe("a");
  });

  it("also drops CI aliases that hold the same secret, such as Bamboo's", () => {
    const env = {
      DROID_BITBUCKET_TOKEN: "bb-secret",
      bamboo_DROID_BITBUCKET_TOKEN_SECRET: "bb-secret",
      DROID_BITBUCKET_USERNAME: "dev@example.com",
      DROID_BITBUCKET_API_TOKEN: "api-secret",
      bamboo_API_TOKEN_SECRET: " api-secret ",
      bamboo_planKey: "PROJ-PLAN",
      AUTHOR_EMAIL: "dev@example.com",
    };
    expect(withoutBitbucketCredentials(env)).toEqual({
      bamboo_planKey: "PROJ-PLAN",
      // A username is not a secret; only token values are matched.
      AUTHOR_EMAIL: "dev@example.com",
    });
  });
});
