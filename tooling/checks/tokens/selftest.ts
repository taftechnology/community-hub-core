import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const TOKENS_JSON = "packages/tokens/src/tokens.json";

const fixtureExpectations: Record<string, readonly string[]> = {
  valid: [],
  "drift-tokens": ["drift-tokens"],
  "drift-theme": ["drift-theme"],
  "contrast-fail": ["contrast"],
  "missing-pair": ["missing-pair"],
  "mode-keys": ["mode-keys"],
  "unknown-purpose": ["unknown-purpose"],
  "unknown-key": ["unknown-key"],
  "unknown-group": ["unknown-group"],
  "unknown-var": ["unknown-var"],
  "bad-color": ["bad-color"],
  "bad-key": ["bad-key"],
  "bad-value": ["bad-value"],
  "missing-tokens": ["missing-tokens"],
  "invalid-tokens": ["invalid-tokens"],
};

async function violationIds(root: string): Promise<string[]> {
  const result = await check(root);
  return result.violations.map((v) => v.id).sort();
}

describe("token check fixtures", () => {
  for (const [name, expectedIds] of Object.entries(fixtureExpectations)) {
    it(`fixture ${name} has violation ids ${JSON.stringify([...expectedIds].sort())}`, async () => {
      const root = path.join(fixturesDir, name);
      expect(await violationIds(root)).toEqual([...expectedIds].sort());
    });
  }

  it("missing-tokens message names the absent file path", async () => {
    const result = await check(path.join(fixturesDir, "missing-tokens"));
    expect(result.violations).toHaveLength(1);
    const message = result.violations[0]?.message ?? "";
    expect(message.toLowerCase()).toMatch(/absent|missing/);
    expect(message).toContain(TOKENS_JSON);
  });

  it("invalid-tokens message says the file is not valid JSON", async () => {
    const result = await check(path.join(fixturesDir, "invalid-tokens"));
    expect(result.violations).toHaveLength(1);
    const message = result.violations[0]?.message ?? "";
    expect(message.toLowerCase()).toMatch(/not valid json|invalid json/);
    expect(message).toContain(TOKENS_JSON);
  });
});
