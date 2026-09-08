import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  parseReviewPostResults,
  readReviewPostOutcome,
} from "../../../../src/core/review/tracking/results";

const valid = {
  posted: 2,
  fallbackPosted: 1,
  approved: 3,
  rejected: 4,
  failed: 0,
  skipped: 1,
  summaryBody: "Summary",
  failures: [],
};

describe("review post results", () => {
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporary.map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
    temporary.length = 0;
  });

  it("validates and maps the complete posting result", () => {
    expect(parseReviewPostResults(JSON.stringify(valid))).toEqual(valid);
    expect(() =>
      parseReviewPostResults(JSON.stringify({ ...valid, posted: -1 })),
    ).toThrow("invalid `posted`");
    expect(() =>
      parseReviewPostResults(JSON.stringify({ ...valid, failures: null })),
    ).toThrow("invalid `failures`");
  });

  it("returns null only for a missing file and rejects malformed output", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "review-results-"),
    );
    temporary.push(directory);
    const filePath = path.join(directory, "results.json");

    expect(await readReviewPostOutcome(filePath)).toBeNull();

    await fs.writeFile(filePath, "{bad json");
    await expect(readReviewPostOutcome(filePath)).rejects.toThrow();

    await fs.writeFile(filePath, JSON.stringify(valid));
    expect(await readReviewPostOutcome(filePath)).toEqual({
      posted: 2,
      fallbackPosted: 1,
      failed: 0,
      skipped: 1,
      summaryBody: "Summary",
    });
  });
});
