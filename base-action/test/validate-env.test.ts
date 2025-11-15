#!/usr/bin/env bun

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { validateEnvironmentVariables } from "../src/validate-env";

describe("validateEnvironmentVariables", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.FACTORY_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("passes when FACTORY_API_KEY is set", () => {
    process.env.FACTORY_API_KEY = 'test-factory-key';
    expect(() => validateEnvironmentVariables()).not.toThrow();
  });

  test("throws when FACTORY_API_KEY is missing", () => {
    expect(() => validateEnvironmentVariables()).toThrow(
      'FACTORY_API_KEY is required to run Droid Exec. Please provide the factory_api_key input.'
    );
  });
});
