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
  url: asset(774140751),
  sha256: "c8ef33bc22b9013ba885ab4cc0543d1a7312884aa284aa42dc12dea47a39424c",
};

/**
 * The judge a review is run with, by what it reviews for. A judge is handed
 * to the worker as it was downloaded; nothing here reads a field of it.
 */
export const REVIEW_JUDGES: Record<"code" | "security", Pin> = {
  code: {
    name: "review-judge.json",
    url: asset(774140752),
    sha256: "3e3104dc4f4337f1ef6599839307b7e0144f7472d390e0c898780999507de281",
  },
  security: {
    name: "security-review-judge.json",
    url: asset(774140750),
    sha256: "918cca199490dd2d741b7db419f8a1c2647b7f2622fe39ccfa103eb9d20b3fed",
  },
};
