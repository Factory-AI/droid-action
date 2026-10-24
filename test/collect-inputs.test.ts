import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { collectActionInputsPresence } from "../src/entrypoints/collect-inputs";

describe("security input presence", () => {
  const originalInputs = process.env.ALL_INPUTS;
  const action = parse(
    readFileSync(join(import.meta.dir, "../action.yml"), "utf8"),
  );

  afterEach(() => {
    if (originalInputs === undefined) delete process.env.ALL_INPUTS;
    else process.env.ALL_INPUTS = originalInputs;
  });

  it.each([
    ["omitted", undefined, false],
    ["explicit false", "false", true],
    ["explicit true", "true", true],
  ] as const)(
    "records %s separately from the default",
    (_name, value, expected) => {
      process.env.ALL_INPUTS = JSON.stringify({
        automatic_security_review:
          value ?? action.inputs.automatic_security_review.default ?? "",
      });
      const output = spyOn(core, "setOutput").mockImplementation(() => {});
      try {
        collectActionInputsPresence();
        const call = output.mock.calls.find(
          ([name]) => name === "action_inputs_present",
        );
        expect(JSON.parse(String(call?.[1])).automatic_security_review).toBe(
          expected,
        );
      } finally {
        output.mockRestore();
      }
    },
  );
});
