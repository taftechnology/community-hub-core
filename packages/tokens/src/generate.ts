export type Violation = { id: string; message: string };

const ALLOWED_TOP_LEVEL = new Set([
  "space",
  "radius",
  "fontSize",
  "fontWeight",
  "modes",
  "pairs",
  "type",
  "spacing",
  "size",
  "shadow",
  "decorative",
]);

const KEY_PATTERN = /^[a-z0-9-]+$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;
const RGBA_PATTERN = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)$/;
const PURPOSES = new Set(["text", "large-text", "non-text"]);
const MODES = new Set(["light", "dark"]);

export const ALLOWED_DECORATIVE_ROLES = [
  "border",
  "control-border",
  "control-border-hover",
  "tint-border",
  "destructive-border",
  "warning-border",
  "info-border",
  "restricted-border",
  "sidebar-border",
  "scrim",
] as const;

const ALLOWED_DECORATIVE_SET = new Set<string>(ALLOWED_DECORATIVE_ROLES);

export const BANNED_PREFIXES = [
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
] as const;

function violation(id: string, message: string): Violation {
  return { id, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function linearize(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

export function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

export function namespaceViolations(propertyNames: string[]): Violation[] {
  const hits: Violation[] = [];
  for (const name of propertyNames) {
    if (BANNED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      hits.push(violation("namespace", `Token property ${name} uses a banned Tailwind namespace`));
    }
  }
  return hits;
}

export function selfReferenceViolations(themeCss: string): Violation[] {
  const hits: Violation[] = [];
  const declarationPattern = /(--[a-z0-9-]+)\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/g;
  for (const match of themeCss.matchAll(declarationPattern)) {
    const property = match[1];
    const reference = match[2];
    if (property !== undefined && property === reference) {
      hits.push(
        violation("self-reference", `Theme property ${property} must not reference itself`),
      );
    }
  }
  return hits;
}

function unknownGroupViolations(value: unknown): Violation[] {
  if (!isRecord(value)) {
    return [];
  }
  const hits: Violation[] = [];
  for (const key of Object.keys(value)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      hits.push(violation("unknown-group", `Unknown top-level group ${key}`));
    }
  }
  return hits;
}

function badKeyViolations(value: unknown): Violation[] {
  if (!isRecord(value)) {
    return [];
  }
  const hits: Violation[] = [];
  const reportedKeys = new Set<string>();
  const keyedGroups = ["radius", "fontSize", "fontWeight"] as const;
  for (const group of keyedGroups) {
    const groupValue = value[group];
    if (!isRecord(groupValue)) {
      continue;
    }
    for (const key of Object.keys(groupValue)) {
      if (!KEY_PATTERN.test(key) && !reportedKeys.has(key)) {
        reportedKeys.add(key);
        hits.push(violation("bad-key", `Invalid key ${key} in ${group}`));
      }
    }
  }
  const modes = value.modes;
  if (isRecord(modes)) {
    for (const mode of MODES) {
      const modeValue = modes[mode];
      if (!isRecord(modeValue)) {
        continue;
      }
      const colors = modeValue.color;
      if (!isRecord(colors)) {
        continue;
      }
      for (const key of Object.keys(colors)) {
        if (!KEY_PATTERN.test(key) && !reportedKeys.has(key)) {
          reportedKeys.add(key);
          hits.push(violation("bad-key", `Invalid color key ${key}`));
        }
      }
    }
  }
  return hits;
}

function badValueViolations(value: unknown): Violation[] {
  if (!isRecord(value)) {
    return [];
  }
  const hits: Violation[] = [];
  if (!isNonNegativeFiniteNumber(value.space)) {
    hits.push(violation("bad-value", "space must be a non-negative finite number"));
  }
  const numericGroups = ["radius", "fontSize", "fontWeight"] as const;
  for (const group of numericGroups) {
    const groupValue = value[group];
    if (!isRecord(groupValue)) {
      continue;
    }
    for (const [key, entry] of Object.entries(groupValue)) {
      if (group === "radius" && key === "pill" && (entry === 999 || entry === "999px")) {
        continue;
      }
      if (!isNonNegativeFiniteNumber(entry)) {
        hits.push(violation("bad-value", `Invalid ${group} value for ${key}`));
      }
    }
  }
  return hits;
}

function badColorViolations(value: unknown): Violation[] {
  if (!isRecord(value)) {
    return [];
  }
  const modes = value.modes;
  if (!isRecord(modes)) {
    return [];
  }
  const hits: Violation[] = [];
  for (const mode of MODES) {
    const modeValue = modes[mode];
    if (!isRecord(modeValue)) {
      continue;
    }
    const colors = modeValue.color;
    if (!isRecord(colors)) {
      continue;
    }
    for (const [key, color] of Object.entries(colors)) {
      if (typeof color !== "string" || (!COLOR_PATTERN.test(color) && !RGBA_PATTERN.test(color))) {
        hits.push(violation("bad-color", `Invalid color for ${mode}.${key}`));
      }
    }
  }
  return hits;
}

export function decorativeViolations(value: unknown): Violation[] {
  if (!isRecord(value)) {
    return [];
  }
  const hits: Violation[] = [];
  const decorativeSet = new Set<string>();
  if (Array.isArray(value.decorative)) {
    for (const item of value.decorative) {
      if (typeof item === "string") {
        decorativeSet.add(item);
      }
    }
  }

  const modes = value.modes;
  const knownColorRoles = new Set<string>();
  if (isRecord(modes)) {
    if (isRecord(modes.light) && isRecord(modes.light.color)) {
      for (const k of Object.keys(modes.light.color)) {
        knownColorRoles.add(k);
      }
    }
    if (isRecord(modes.dark) && isRecord(modes.dark.color)) {
      for (const k of Object.keys(modes.dark.color)) {
        knownColorRoles.add(k);
      }
    }
  }

  for (const name of decorativeSet) {
    if (!knownColorRoles.has(name)) {
      hits.push(
        violation("decorative-unknown", `Decorative role ${name} is not a declared colour role`),
      );
    } else if (!ALLOWED_DECORATIVE_SET.has(name)) {
      hits.push(
        violation(
          "decorative-not-allowed",
          `Decorative role ${name} is not on the allowed decorative list`,
        ),
      );
    }
  }

  const reportedInPair = new Set<string>();
  const pairs = value.pairs;
  if (Array.isArray(pairs)) {
    for (const pair of pairs) {
      if (!isRecord(pair)) continue;
      for (const role of ["foreground", "background"] as const) {
        const name = pair[role];
        if (typeof name === "string" && decorativeSet.has(name) && !reportedInPair.has(name)) {
          reportedInPair.add(name);
          hits.push(
            violation("decorative-in-pair", `Decorative role ${name} must not appear in pairs`),
          );
        }
      }
    }
  }

  const reportedRgba = new Set<string>();
  if (isRecord(modes)) {
    for (const mode of MODES) {
      const modeValue = modes[mode];
      if (!isRecord(modeValue)) continue;
      const colors = modeValue.color;
      if (!isRecord(colors)) continue;
      for (const [key, color] of Object.entries(colors)) {
        if (typeof color === "string" && RGBA_PATTERN.test(color)) {
          if (!decorativeSet.has(key) && !reportedRgba.has(key)) {
            reportedRgba.add(key);
            hits.push(
              violation(
                "rgba-non-decorative",
                `Color ${mode}.${key} uses rgba but is not declared decorative`,
              ),
            );
          }
        }
      }
    }
  }

  return hits;
}

function modeKeysViolations(value: unknown): Violation[] {
  if (!isRecord(value)) {
    return [];
  }
  const modes = value.modes;
  if (!isRecord(modes)) {
    return [];
  }
  const light = modes.light;
  const dark = modes.dark;
  if (!isRecord(light) || !isRecord(dark)) {
    return [];
  }
  const lightColors = light.color;
  const darkColors = dark.color;
  if (!isRecord(lightColors) || !isRecord(darkColors)) {
    return [];
  }
  const lightKeys = new Set(Object.keys(lightColors));
  const darkKeys = new Set(Object.keys(darkColors));
  const hits: Violation[] = [];
  for (const key of lightKeys) {
    if (!darkKeys.has(key)) {
      hits.push(violation("mode-keys", `Color key ${key} is missing from dark mode`));
    }
  }
  for (const key of darkKeys) {
    if (!lightKeys.has(key)) {
      hits.push(violation("mode-keys", `Color key ${key} is missing from light mode`));
    }
  }
  return hits;
}

function unknownPurposeViolations(value: unknown): Violation[] {
  if (!isRecord(value)) {
    return [];
  }
  const pairs = value.pairs;
  if (!Array.isArray(pairs)) {
    return [];
  }
  const hits: Violation[] = [];
  for (const pair of pairs) {
    if (!isRecord(pair)) {
      continue;
    }
    const purpose = pair.purpose;
    if (typeof purpose !== "string" || !PURPOSES.has(purpose)) {
      hits.push(violation("unknown-purpose", `Unknown contrast purpose ${String(purpose)}`));
    }
  }
  return hits;
}

function unknownKeyViolations(value: unknown): Violation[] {
  if (!isRecord(value)) {
    return [];
  }
  const modes = value.modes;
  if (!isRecord(modes)) {
    return [];
  }
  const pairs = value.pairs;
  if (!Array.isArray(pairs)) {
    return [];
  }
  const hits: Violation[] = [];
  for (const pair of pairs) {
    if (!isRecord(pair)) {
      continue;
    }
    const mode = pair.mode;
    if (typeof mode !== "string" || !MODES.has(mode)) {
      continue;
    }
    const modeValue = modes[mode];
    if (!isRecord(modeValue)) {
      continue;
    }
    const colors = modeValue.color;
    if (!isRecord(colors)) {
      continue;
    }
    const colorKeys = new Set(Object.keys(colors));
    for (const role of ["foreground", "background"] as const) {
      const key = pair[role];
      if (typeof key !== "string" || !colorKeys.has(key)) {
        hits.push(violation("unknown-key", `Pair references unknown color key ${String(key)}`));
      }
    }
  }
  return hits;
}

export function validateTokens(value: unknown): Violation[] {
  return [
    ...unknownGroupViolations(value),
    ...badColorViolations(value),
    ...badKeyViolations(value),
    ...badValueViolations(value),
    ...modeKeysViolations(value),
    ...unknownKeyViolations(value),
    ...unknownPurposeViolations(value),
    ...decorativeViolations(value),
  ];
}

export function missingPairViolations(value: unknown): Violation[] {
  if (!isRecord(value)) {
    return [];
  }
  const modes = value.modes;
  if (!isRecord(modes)) {
    return [];
  }
  const light = modes.light;
  const dark = modes.dark;
  if (!isRecord(light) || !isRecord(dark)) {
    return [];
  }
  const lightColors = light.color;
  const darkColors = dark.color;
  if (!isRecord(lightColors) || !isRecord(darkColors)) {
    return [];
  }
  const decorativeSet = new Set<string>();
  if (Array.isArray(value.decorative)) {
    for (const d of value.decorative) {
      if (typeof d === "string") {
        decorativeSet.add(d);
      }
    }
  }
  const sharedKeys = Object.keys(lightColors)
    .filter((key) => Object.hasOwn(darkColors, key))
    .filter((key) => !decorativeSet.has(key));
  const pairs = value.pairs;
  if (!Array.isArray(pairs)) {
    return [];
  }
  const hits: Violation[] = [];
  for (const mode of MODES) {
    const modePairs = pairs.filter((pair) => isRecord(pair) && pair.mode === mode);
    const keysInPairs = new Set<string>();
    for (const pair of modePairs) {
      if (!isRecord(pair)) {
        continue;
      }
      if (typeof pair.foreground === "string") {
        keysInPairs.add(pair.foreground);
      }
      if (typeof pair.background === "string") {
        keysInPairs.add(pair.background);
      }
    }
    for (const key of sharedKeys) {
      if (!keysInPairs.has(key)) {
        hits.push(violation("missing-pair", `Color key ${key} is missing from ${mode} pairs`));
      }
    }
  }
  return hits;
}

export function contrastViolations(value: unknown): Violation[] {
  if (!isRecord(value)) {
    return [];
  }
  const modes = value.modes;
  if (!isRecord(modes)) {
    return [];
  }
  const pairs = value.pairs;
  if (!Array.isArray(pairs)) {
    return [];
  }
  const hits: Violation[] = [];
  for (const pair of pairs) {
    if (!isRecord(pair)) {
      continue;
    }
    const mode = pair.mode;
    const purpose = pair.purpose;
    const foregroundKey = pair.foreground;
    const backgroundKey = pair.background;
    if (
      typeof mode !== "string" ||
      !MODES.has(mode) ||
      typeof purpose !== "string" ||
      typeof foregroundKey !== "string" ||
      typeof backgroundKey !== "string"
    ) {
      continue;
    }
    const modeValue = modes[mode];
    if (!isRecord(modeValue)) {
      continue;
    }
    const colors = modeValue.color;
    if (!isRecord(colors)) {
      continue;
    }
    const foreground = colors[foregroundKey];
    const background = colors[backgroundKey];
    if (typeof foreground !== "string" || typeof background !== "string") {
      continue;
    }
    const ratio = contrastRatio(foreground, background);
    const passes = purpose === "text" ? ratio >= 4.5 : ratio >= 3;
    if (!passes) {
      hits.push(
        violation("contrast", `Contrast ratio ${ratio} fails ${purpose} for ${String(pair.id)}`),
      );
    }
  }
  return hits;
}

function pxToRem(px: number): string {
  const rem = px / 16;
  const formatted = rem
    .toFixed(10)
    .replace(/\.?0+$/, "")
    .replace(/\.$/, ".0");
  return `${formatted}rem`;
}

function formatBlock(selector: string, declarations: string[]): string {
  if (declarations.length === 0) {
    return "";
  }
  return `${selector} {\n${declarations.map((line) => `  ${line}`).join("\n")}\n}\n`;
}

function formatMediaBlock(mediaQuery: string, selector: string, declarations: string[]): string {
  if (declarations.length === 0) {
    return "";
  }
  return `${mediaQuery} {\n  ${selector} {\n${declarations.map((line) => `    ${line}`).join("\n")}\n  }\n}\n`;
}

function sortedDeclarations(entries: Array<[string, string]>): string[] {
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([property, value]) => `${property}: ${value};`);
}

export function generateTokens(value: unknown): { tokensCss: string; themeCss: string } {
  if (!isRecord(value)) {
    return { tokensCss: "", themeCss: "" };
  }

  const space = value.space;
  const radius = isRecord(value.radius) ? value.radius : {};
  const fontSize = isRecord(value.fontSize) ? value.fontSize : {};
  const fontWeight = isRecord(value.fontWeight) ? value.fontWeight : {};
  const type = isRecord(value.type) ? value.type : {};
  const spacing = isRecord(value.spacing) ? value.spacing : {};
  const size = isRecord(value.size) ? value.size : {};
  const shadow = isRecord(value.shadow) ? value.shadow : {};
  const modes = isRecord(value.modes) ? value.modes : {};
  const light = isRecord(modes.light) ? modes.light : {};
  const dark = isRecord(modes.dark) ? modes.dark : {};
  const lightColors = isRecord(light.color) ? light.color : {};
  const darkColors = isRecord(dark.color) ? dark.color : {};

  const sharedTokenEntries: Array<[string, string]> = [];
  if (isNonNegativeFiniteNumber(space)) {
    sharedTokenEntries.push(["--ch-space-unit", pxToRem(space)]);
  }
  for (const [key, px] of Object.entries(radius)) {
    if (key === "pill") {
      sharedTokenEntries.push(["--ch-rounded-pill", "999px"]);
    } else if (isNonNegativeFiniteNumber(px)) {
      sharedTokenEntries.push([`--ch-rounded-${key}`, pxToRem(px)]);
    }
  }
  for (const [key, px] of Object.entries(fontSize)) {
    if (isNonNegativeFiniteNumber(px)) {
      sharedTokenEntries.push([`--ch-type-${key}`, pxToRem(px)]);
    }
  }
  for (const [key, weight] of Object.entries(fontWeight)) {
    if (isNonNegativeFiniteNumber(weight)) {
      sharedTokenEntries.push([`--ch-weight-${key}`, String(weight)]);
    }
  }

  if (isRecord(type.families) && typeof type.families.sans === "string") {
    sharedTokenEntries.push(["--ch-font-sans", type.families.sans]);
  }
  if (Array.isArray(type.groups)) {
    for (const group of type.groups) {
      if (isRecord(group) && Array.isArray(group.styles)) {
        for (const style of group.styles) {
          if (isRecord(style) && typeof style.name === "string") {
            if (typeof style.fontSize === "string") {
              sharedTokenEntries.push([`--ch-type-${style.name}-font-size`, style.fontSize]);
            }
            if (typeof style.lineHeight === "string") {
              sharedTokenEntries.push([`--ch-type-${style.name}-line-height`, style.lineHeight]);
            }
            if (typeof style.fontWeight === "number" || typeof style.fontWeight === "string") {
              sharedTokenEntries.push([
                `--ch-type-${style.name}-font-weight`,
                String(style.fontWeight),
              ]);
            }
            if (typeof style.letterSpacing === "string") {
              sharedTokenEntries.push([
                `--ch-type-${style.name}-letter-spacing`,
                style.letterSpacing,
              ]);
            }
          }
        }
      }
    }
  }

  const spacingTokens: Array<{ name: string; value: string }> = [];
  if (Array.isArray(spacing.tokens)) {
    for (const token of spacing.tokens) {
      if (isRecord(token) && typeof token.name === "string" && typeof token.value === "string") {
        sharedTokenEntries.push([`--ch-${token.name}`, token.value]);
        spacingTokens.push({ name: token.name, value: token.value });
      }
    }
  }

  const sizeTokens: Array<{ name: string; value: string }> = [];
  if (Array.isArray(size.tokens)) {
    for (const token of size.tokens) {
      if (isRecord(token) && typeof token.name === "string" && typeof token.value === "string") {
        sharedTokenEntries.push([`--ch-${token.name}`, token.value]);
        sizeTokens.push({ name: token.name, value: token.value });
      }
    }
  }

  const shadowTokens: Array<{ name: string; light: string; dark: string }> = [];
  if (Array.isArray(shadow.tokens)) {
    for (const token of shadow.tokens) {
      if (
        isRecord(token) &&
        typeof token.name === "string" &&
        isRecord(token.value) &&
        typeof token.value.light === "string" &&
        typeof token.value.dark === "string"
      ) {
        shadowTokens.push({
          name: token.name,
          light: token.value.light,
          dark: token.value.dark,
        });
      }
    }
  }

  const lightEntries = Object.entries(lightColors)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, color]) => [`--ch-${key}`, color] as [string, string]);
  for (const s of shadowTokens) {
    lightEntries.push([`--ch-${s.name}`, s.light]);
  }

  const darkEntries = Object.entries(darkColors)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, color]) => [`--ch-${key}`, color] as [string, string]);
  for (const s of shadowTokens) {
    darkEntries.push([`--ch-${s.name}`, s.dark]);
  }

  const lightDeclarations = sortedDeclarations([...sharedTokenEntries, ...lightEntries]);
  const darkDeclarations = sortedDeclarations(darkEntries);

  const tokensCss = [
    formatBlock(":root", lightDeclarations),
    formatBlock('[data-theme="dark"]', darkDeclarations),
    formatMediaBlock(
      "@media (prefers-color-scheme: dark)",
      ':root:not([data-theme="light"])',
      darkDeclarations,
    ),
  ].join("\n");

  const themeEntries: Array<[string, string]> = [
    ["--spacing", "var(--ch-space-unit)"],
    ...spacingTokens.flatMap((t) => {
      const entries: Array<[string, string]> = [[`--spacing-${t.name}`, `var(--ch-${t.name})`]];
      if (t.name.startsWith("space-")) {
        entries.push([`--spacing-${t.name.slice(6)}`, `var(--ch-${t.name})`]);
      }
      return entries;
    }),
    ...sizeTokens.map((t) => [`--${t.name}`, `var(--ch-${t.name})`] as [string, string]),
    ...shadowTokens.map((t) => [`--${t.name}`, `var(--ch-${t.name})`] as [string, string]),
    ...Object.keys(radius)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [`--radius-${key}`, `var(--ch-rounded-${key})`] as [string, string]),
    ...Object.keys(fontSize)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [`--text-${key}`, `var(--ch-type-${key})`] as [string, string]),
    ...Object.keys(fontWeight)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [`--font-weight-${key}`, `var(--ch-weight-${key})`] as [string, string]),
    ...Object.keys(lightColors)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [`--color-${key}`, `var(--ch-${key})`] as [string, string]),
  ];

  if (isRecord(type.families) && typeof type.families.sans === "string") {
    themeEntries.push(["--font-sans", "var(--ch-font-sans)"]);
  }

  const customVariantDark = [
    "@custom-variant dark {",
    '  &:is([data-theme="dark"] *) {',
    "    @slot;",
    "  }",
    "  @media (prefers-color-scheme: dark) {",
    '    &:is(html:not([data-theme="light"]) *) {',
    "      @slot;",
    "    }",
    "  }",
    "}",
  ].join("\n");

  const customVariantTouch = [
    "@custom-variant touch {",
    "  @media (pointer: coarse) {",
    "    @slot;",
    "  }",
    "  @media (width < 40rem) {",
    "    @slot;",
    "  }",
    "}",
  ].join("\n");

  const themeCss = [
    '@source "./src";',
    '@source not "./src/**/*.test.*";',
    '@source not "./src/alias.ts";',
    '@source not "./src/cli-pin.ts";',
    '@source not "./src/opacity.ts";',
    '@source not "./src/write-theme-css.ts";',
    customVariantDark,
    customVariantTouch,
    "@theme inline {",
    ...sortedDeclarations(themeEntries).map((line) => `  ${line}`),
    "}",
    "",
  ].join("\n");

  return { tokensCss, themeCss };
}
