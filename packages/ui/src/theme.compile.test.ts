// @vitest-environment node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";

const uiPackageDir = path.dirname(fileURLToPath(new URL("../", import.meta.url)));

const input = `@import "tailwindcss";
@import "@community-hub/tokens/tokens.css";
@import "@community-hub/ui/theme.css";
`;

const candidates = [
  "rounded-md",
  "rounded-lg",
  "text-sm",
  "text-xs",
  "font-medium",
  "rounded-[min(var(--radius-md),10px)]",
] as const;

it("maps theme utilities to --ch-* token properties", async () => {
  const result = await compile(input, {
    base: uiPackageDir,
    onDependency: () => {},
  });
  expect(result.build([...candidates])).toBeTypeOf("string");

  const expected: Record<string, string> = {
    "rounded-md": "var(--ch-rounded-md)",
    "rounded-lg": "var(--ch-rounded-lg)",
    "text-sm": "var(--ch-type-sm)",
    "text-xs": "var(--ch-type-xs)",
    "font-medium": "var(--ch-weight-medium)",
  };

  for (const [candidate, tokenVar] of Object.entries(expected)) {
    const css = result.build([candidate]);
    expect(css, candidate).toContain(tokenVar);
  }

  const arbitraryCss = result.build(["rounded-[min(var(--radius-md),10px)]"]);
  expect(arbitraryCss).toContain("var(--radius-md)");
  expect(arbitraryCss).toContain("--radius-md: var(--ch-rounded-md)");
});
