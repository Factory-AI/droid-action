/**
 * A file this version of the action downloads and uses: an asset of a
 * release of the private `droid-review` repository, which GitHub serves only
 * to a token that can read it, the name it is kept under on the runner, and
 * the SHA-256 of its bytes. The digest is checked where the bytes are used.
 */
export type Pin = { name: string; url: string; sha256: string };

const asset = (id: number) =>
  `https://api.github.com/repos/Factory-AI/droid-review/releases/assets/${id}`;

/** The built `droid-review` worker, which runs both `risk` and `review`. */
export const WORKER: Pin = {
  name: "droid-review.mjs",
  url: asset(764051876),
  sha256: "af384ffbd6e353dae4051d9ec249d0592615de17f23d978b1719981c0c89b0ae",
};

/**
 * The judge a review is run with, by what it reviews for. A judge is handed
 * to the worker as it was downloaded; nothing here reads a field of it.
 */
export const REVIEW_JUDGES: Record<"code" | "security", Pin> = {
  code: {
    name: "review-judge.json",
    url: asset(764051877),
    sha256: "bce0c891196aa21c693b76040470aed7b2f14a4bb5e1322aae4af5b76b8c502e",
  },
  security: {
    name: "security-review-judge.json",
    url: asset(0),
    sha256: "0".repeat(64),
  },
};
