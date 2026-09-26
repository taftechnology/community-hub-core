import { describe, expect, it } from "vitest";

import tokens from "./tokens.json" with { type: "json" };

import {
  contrastRatio,
  contrastViolations,
  generateTokens,
  missingPairViolations,
  namespaceViolations,
  selfReferenceViolations,
  validateTokens,
} from "./generate.js";

const BANNED_PREFIXES = [
  "--color-",
  "--font-",
  "--text-",
  "--font-weight-",
  "--tracking-",
  "--leading-",
  "--breakpoint-",
  "--container-",
  "--spacing-",
  "--radius-",
  "--shadow-",
  "--inset-shadow-",
  "--drop-shadow-",
  "--blur-",
  "--perspective-",
  "--aspect-",
  "--ease-",
  "--animate-",
];

describe("contrastRatio", () => {
  it("classifies mid-gray on white between 3 and 4.5", () => {
    const ratio = contrastRatio("#888888", "#ffffff");
    expect(ratio).toBeGreaterThanOrEqual(3);
    expect(ratio).toBeLessThan(4.5);
  });

  it("classifies near-black on white at or above 4.5", () => {
    expect(contrastRatio("#171717", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("treats 4.499 as failing the text threshold", () => {
    expect(4.499 >= 4.5).toBe(false);
  });
});

describe("validateTokens", () => {
  it("accepts the committed token source", () => {
    expect(validateTokens(tokens)).toEqual([]);
    expect(missingPairViolations(tokens)).toEqual([]);
    expect(contrastViolations(tokens)).toEqual([]);
  });

  it("rejects invalid color keys", () => {
    const value = structuredClone(tokens);
    value.modes.light.color["2.5"] = "#ffffff";
    value.modes.dark.color["2.5"] = "#ffffff";
    expect(validateTokens(value)).toEqual([expect.objectContaining({ id: "bad-key" })]);
  });

  it("rejects invalid space values", () => {
    expect(validateTokens({ ...tokens, space: -1 })).toEqual([
      expect.objectContaining({ id: "bad-value" }),
    ]);
    expect(validateTokens({ ...tokens, space: "4" })).toEqual([
      expect.objectContaining({ id: "bad-value" }),
    ]);
  });
});

describe("generateTokens", () => {
  it("maps tokens to ch-prefixed properties and theme aliases", () => {
    const { tokensCss, themeCss } = generateTokens(tokens);
    const combined = `${tokensCss}\n${themeCss}`;
    expect(combined).toContain("--ch-space-unit: 0.25rem");
    expect(combined).toContain("--ch-background: #ffffff");
    expect(combined).toContain("--spacing: var(--ch-space-unit)");
    expect(combined).toContain("--radius-md: var(--ch-rounded-md)");

    for (const prefix of BANNED_PREFIXES) {
      const propertyPattern = new RegExp(`\\${prefix.replace("-", "\\-")}[a-z0-9-]*\\s*:`, "g");
      const tokenBlock = tokensCss;
      expect(tokenBlock.match(propertyPattern)).toBeNull();
    }
  });
});

describe("namespaceViolations", () => {
  it("flags Tailwind namespace names on token properties", () => {
    expect(namespaceViolations(["--shadow-sm"])).toEqual([
      expect.objectContaining({ id: "namespace" }),
    ]);
    expect(namespaceViolations(["--ch-background"])).toEqual([]);
  });
});

describe("selfReferenceViolations", () => {
  it("detects theme variables that reference themselves", () => {
    expect(selfReferenceViolations("--radius-md: var(--radius-md);")).toEqual([
      expect.objectContaining({ id: "self-reference" }),
    ]);
    expect(selfReferenceViolations("--radius-md: var(--ch-rounded-md);")).toEqual([]);
  });
});
