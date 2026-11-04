import { describe, expect, it } from "vitest";

import tokens from "./tokens.json" with { type: "json" };

import {
  contrastRatio,
  contrastViolations,
  decorativeViolations,
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
    expect(combined).toContain("--ch-background: #f8fafc");
    expect(combined).toContain("--spacing: var(--ch-space-unit)");
    expect(combined).toContain("--radius-md: var(--ch-rounded-md)");

    for (const prefix of BANNED_PREFIXES) {
      const propertyPattern = new RegExp(`\\${prefix.replace("-", "\\-")}[a-z0-9-]*\\s*:`, "g");
      const tokenBlock = tokensCss;
      expect(tokenBlock.match(propertyPattern)).toBeNull();
    }
  });

  it("emits radius-pill as 999px without converting to rem", () => {
    const { tokensCss } = generateTokens(tokens);
    expect(tokensCss).toContain("--ch-rounded-pill: 999px");
    expect(tokensCss).not.toContain("62.4375rem");
  });

  it("emits dark values under data-theme and prefers-color-scheme media query, not .dark", () => {
    const { tokensCss } = generateTokens(tokens);
    expect(tokensCss).toContain('[data-theme="dark"]');
    expect(tokensCss).toContain("@media (prefers-color-scheme: dark)");
    expect(tokensCss).toContain(':root:not([data-theme="light"])');
    expect(tokensCss).not.toMatch(/\.dark\s*\{/);
  });

  it("never emits --font-sans in generated tokens.css", () => {
    const { tokensCss } = generateTokens(tokens);
    expect(tokensCss).not.toContain("--font-sans");
  });

  it("emits @custom-variant touch with pointer:coarse and width < 40rem in themeCss", () => {
    const { themeCss } = generateTokens(tokens);
    expect(themeCss).toContain("@custom-variant touch");
    expect(themeCss).toContain("@media (pointer: coarse)");
    expect(themeCss).toContain("@media (width < 40rem)");
  });

  it("accepts and emits each new group (type, spacing, size, shadow, decorative)", () => {
    const { tokensCss, themeCss } = generateTokens(tokens);
    // type
    expect(tokensCss).toContain("--ch-font-sans:");
    expect(themeCss).toContain("--font-sans: var(--ch-font-sans)");
    // spacing
    expect(tokensCss).toContain("--ch-space-4:");
    // size
    expect(tokensCss).toContain("--ch-size-control:");
    // shadow
    expect(tokensCss).toContain("--ch-shadow-overlay:");
    expect(themeCss).toContain("--shadow-overlay: var(--ch-shadow-overlay)");
  });
});

describe("design token contract", () => {
  const EXPECTED_68_ROLES = [
    "background",
    "foreground",
    "card",
    "muted",
    "muted-foreground",
    "subtle-foreground",
    "primary",
    "primary-hover",
    "primary-foreground",
    "primary-ink",
    "tint",
    "tint-border",
    "secondary",
    "secondary-hover",
    "secondary-foreground",
    "border",
    "input",
    "field-border",
    "field-border-hover",
    "control-border",
    "control-border-hover",
    "ring",
    "destructive",
    "destructive-hover",
    "destructive-foreground",
    "destructive-ink",
    "destructive-tint",
    "destructive-border",
    "warning-ink",
    "warning-tint",
    "warning-border",
    "info-ink",
    "info-tint",
    "info-border",
    "restricted-ink",
    "restricted-tint",
    "restricted-border",
    "sidebar",
    "sidebar-foreground",
    "sidebar-muted",
    "sidebar-heading",
    "sidebar-border",
    "sidebar-hover",
    "sidebar-selected",
    "sidebar-selected-foreground",
    "sidebar-ring",
    "sidebar-input",
    "tone-blue-tint",
    "tone-blue-ink",
    "tone-green-tint",
    "tone-green-ink",
    "tone-orange-tint",
    "tone-orange-ink",
    "tone-violet-tint",
    "tone-violet-ink",
    "tone-pink-tint",
    "tone-pink-ink",
    "tone-fuchsia-tint",
    "tone-fuchsia-ink",
    "tone-teal-tint",
    "tone-teal-ink",
    "tone-amber-tint",
    "tone-amber-ink",
    "tone-rose-tint",
    "tone-rose-ink",
    "tone-cyan-tint",
    "tone-cyan-ink",
    "scrim",
  ];

  it("contains exactly the 68 design colour roles in both light and dark modes", () => {
    expect(EXPECTED_68_ROLES).toHaveLength(68);
    const lightRoles = Object.keys(tokens.modes.light.color).sort();
    const darkRoles = Object.keys(tokens.modes.dark.color).sort();
    const expectedSorted = [...EXPECTED_68_ROLES].sort();
    expect(lightRoles).toEqual(expectedSorted);
    expect(darkRoles).toEqual(expectedSorted);
  });

  it("accepts rgba only for decorative roles", () => {
    const validWithScrim = structuredClone(tokens);
    expect(validateTokens(validWithScrim)).toEqual([]);

    const invalidRgba = structuredClone(tokens);
    const mutatedModes: { light: { color: Record<string, string> } } = invalidRgba.modes;
    mutatedModes.light.color.primary = "rgba(15, 118, 110, 0.5)";
    expect(validateTokens(invalidRgba)).toEqual([
      expect.objectContaining({ id: "rgba-non-decorative" }),
    ]);
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

describe("decorativeViolations", () => {
  it("flags declared colour roles that are not on the allowed decorative list", () => {
    const invalidTokens = structuredClone(tokens);
    invalidTokens.decorative = [...invalidTokens.decorative, "foreground"];
    invalidTokens.pairs = invalidTokens.pairs.filter(
      (p: { foreground: string; background: string }) =>
        p.foreground !== "foreground" && p.background !== "foreground",
    );
    expect(decorativeViolations(invalidTokens)).toEqual([
      expect.objectContaining({ id: "decorative-not-allowed" }),
    ]);
  });
});
