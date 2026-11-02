import { describe, expect, it } from "bun:test";
import {
  decodeReviewState,
  encodeReviewState,
  encodeFindingMarker,
} from "../../src/core/review/markers";
import { reconcileFindings } from "../../src/core/review/incremental";
import { normalizeFinding } from "../../src/core/review/validated/finding";
import {
  findingFromState,
  reconcileDiscussionState,
  stateFinding,
} from "../../src/gitlab/operations/review-ux";

describe("GitLab canonical thread roundtrip", () => {
  for (const legacy of [false, true])
    it(`retains the ${legacy ? "legacy" : "canonical"} discussion through reconciliation`, () => {
      const finding = normalizeFinding({
        id: "owned-finding",
        severity: "P1",
        title: "Retain linkage",
        path: "src/x.ts",
        line: 10,
      });
      const original = stateFinding({
        ...finding,
        threadId: "owned-discussion",
        threadUrl: "https://gitlab.test/#note_1",
      });
      if (legacy) delete original.threadId;
      const memory = decodeReviewState(
        encodeReviewState({ head: "a".repeat(40), findings: [original] }),
      )!;
      const reconciled = reconcileFindings({
        previous: memory.findings.map(findingFromState),
        current: [],
        head: "b".repeat(40),
      });
      const persisted = decodeReviewState(
        encodeReviewState({
          head: "b".repeat(40),
          findings: reconciled.findings.map(stateFinding),
        }),
      )!;
      expect(persisted.findings[0]!.threadId).toBe("owned-discussion");
      expect(persisted.findings[0]!.url).toBe("https://gitlab.test/#note_1");
      const dismissed = reconcileDiscussionState(
        persisted,
        [
          {
            id: "owned-discussion",
            individual_note: false,
            notes: [
              {
                id: 1,
                author: { id: 1, username: "bot" },
                body: encodeFindingMarker({ id: finding.id, sev: "P1" }),
                resolved: true,
                type: null,
                created_at: "",
                updated_at: "",
                system: false,
                noteable_id: 7,
                noteable_iid: 7,
                noteable_type: "MergeRequest",
                resolvable: true,
              },
            ],
          },
        ],
        1,
      );
      expect(dismissed.findings[0]!.state).toBe("dismissed");
    });
});
