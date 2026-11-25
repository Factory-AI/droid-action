/** Bitbucket fixtures for tests that use the shared fake server. */

import type { DcDiff } from "../../src/bitbucket/api/datacenter";
import { json } from "../helpers/fake-server";

export {
  json,
  startFakeServer,
  type FakeServer,
  type RecordedRequest,
} from "../helpers/fake-server";

export const notFound = () => json({ error: "no route" }, 404);

/** Sample diff shared by the posting tests. Line roles:
 *  new 1 ctx(old 1), new 2-3 added, new 4 ctx(old 3), new 5 ctx(old 4);
 *  old 2 removed. */
export const APP_TS_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " export { a };",
  " export { b };",
  "",
].join("\n");

/** Data Center's structured diff for the same change as APP_TS_DIFF. */
export const APP_TS_DC_DIFF: DcDiff = {
  source: { toString: "src/app.ts" },
  destination: { toString: "src/app.ts" },
  hunks: [
    {
      sourceLine: 1,
      sourceSpan: 4,
      destinationLine: 1,
      destinationSpan: 5,
      segments: [
        {
          type: "CONTEXT",
          lines: [{ source: 1, destination: 1, line: "const a = 1;" }],
        },
        {
          type: "REMOVED",
          lines: [{ source: 2, destination: 2, line: "const b = 2;" }],
        },
        {
          type: "ADDED",
          lines: [
            { source: 3, destination: 2, line: "const b = 3;" },
            { source: 3, destination: 3, line: "const c = 4;" },
          ],
        },
        {
          type: "CONTEXT",
          lines: [
            { source: 3, destination: 4, line: "export { a };" },
            { source: 4, destination: 5, line: "export { b };" },
          ],
        },
      ],
    },
  ],
};
