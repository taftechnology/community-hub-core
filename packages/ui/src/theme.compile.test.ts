// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";

const uiPackageDir = fileURLToPath(new URL("..", import.meta.url));

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
  "bg-background",
  "rounded-[min(var(--radius-md),10px)]",
] as const;

const arbitrarySelector = String.raw`.rounded-\[min\(var\(--radius-md\)\,10px\)\]`;

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) {
    throw new Error(`No rule for ${selector}`);
  }
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

it("inlines token values in each utility rule", async () => {
  const result = await compile(input, {
    base: uiPackageDir,
    onDependency: () => {},
  });
  const css = result.build([...candidates]);

  expect(ruleBody(css, ".rounded-md")).toContain("border-radius: var(--ch-rounded-md)");
  expect(ruleBody(css, ".rounded-lg")).toContain("border-radius: var(--ch-rounded-lg)");
  expect(ruleBody(css, ".text-sm")).toContain("font-size: var(--ch-type-sm)");
  expect(ruleBody(css, ".text-xs")).toContain("font-size: var(--ch-type-xs)");
  expect(ruleBody(css, ".font-medium")).toContain("font-weight: var(--ch-weight-medium)");
  expect(ruleBody(css, ".bg-background")).toContain("background-color: var(--ch-background)");
  expect(ruleBody(css, arbitrarySelector)).toContain("border-radius: min(var(--radius-md), 10px)");
  expect(css).toContain("--radius-md: var(--ch-rounded-md)");
});

it("rejects utilities when @theme is not inline", async () => {
  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8").replace(
    "@theme inline {",
    "@theme {",
  );
  const bare = `@import "tailwindcss";
@import "@community-hub/tokens/tokens.css";
${theme}
`;
  const result = await compile(bare, {
    base: uiPackageDir,
    onDependency: () => {},
  });
  const css = result.build(["rounded-md", "bg-background"]);

  expect(ruleBody(css, ".rounded-md")).toContain("border-radius: var(--radius-md)");
  expect(ruleBody(css, ".rounded-md")).not.toContain("var(--ch-rounded-md)");
  expect(ruleBody(css, ".bg-background")).toContain("background-color: var(--color-background)");
  expect(ruleBody(css, ".bg-background")).not.toContain("var(--ch-background)");
});
