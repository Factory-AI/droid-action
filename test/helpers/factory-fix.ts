import { expect } from "bun:test";

export const FACTORY_FIX_BUTTON_IMAGE_URL =
  "https://img.shields.io/badge/Fix%20in%20Factory-ee6018?style=for-the-badge";

export function expectFactoryFixAction(body: string): {
  url: URL;
  task: string;
} {
  const matches = [
    ...body.matchAll(/\[!\[Fix in Factory\]\(([^)\r\n]+)\)\]\(([^)\r\n]+)\)/g),
  ];
  expect(matches).toHaveLength(1);
  const match = matches[0]!;
  expect(match[1]).toBe(FACTORY_FIX_BUTTON_IMAGE_URL);
  const url = new URL(match[2]!);
  expect(url.origin).toBe("https://app.factory.ai");
  expect(url.pathname).toBe("/new");
  expect([...url.searchParams.keys()]).toEqual(["prompt"]);
  const task = url.searchParams.get("prompt");
  expect(task).not.toBeNull();
  return { url, task: task! };
}
