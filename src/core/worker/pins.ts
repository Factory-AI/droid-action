/**
 * A file this version of the action downloads and uses: an asset of a
 * release of the private `droid-review` repository, which GitHub serves only
 * to a token that can read it, the name it is kept under on the runner, and
 * the SHA-256 of its bytes. The digest is checked where the bytes are used.
 */
export type Pin = { name: string; url: string; sha256: string };

/** The built `droid-review` worker, which runs both `risk` and `review`. */
export const WORKER: Pin = {
  name: "droid-review.mjs",
  url: "https://api.github.com/repos/Factory-AI/droid-review/releases/assets/774535180",
  sha256: "9333312cb5efbb5a19164414b4c03bd3fc65f830db7d56674f5feee9a0d30f7e",
};
