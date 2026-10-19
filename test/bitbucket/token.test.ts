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
      scheme: "bearer",
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
      scheme: "basic",
      header: "Basic ZGV2QGV4YW1wbGUuY29tOnNlY3JldA==",
    });
  });

  it("prefers the access token when both are configured", () => {
    expect(
      resolveBitbucketAuth({
        DROID_BITBUCKET_TOKEN: "tok",
        DROID_BITBUCKET_USERNAME: "u",
        DROID_BITBUCKET_API_TOKEN: "p",
      }).scheme,
    ).toBe("bearer");
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
        DROID_BITBUCKET_API_TOKEN: "${APP_PASSWORD}",
      }),
    ).toThrow(UnexpandedBitbucketTokenError);
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
});
