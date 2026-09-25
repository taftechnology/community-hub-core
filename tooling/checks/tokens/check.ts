import fs from "node:fs";
import path from "node:path";
import prettier from "prettier";
import {
  contrastViolations,
  generateTokens,
  missingPairViolations,
  namespaceViolations,
  selfReferenceViolations,
  validateTokens,
  type Violation as TokenViolation,
} from "@community-hub/tokens";

export type Violation = { id: string; message: string };

export type CheckResult = {
  ok: boolean;
  violations: Violation[];
};

const TOKENS_JSON_REL = "packages/tokens/src/tokens.json";
const TOKENS_CSS_REL = "packages/tokens/src/tokens.css";
const THEME_CSS_REL = "packages/ui/theme.css";
const UI_SRC_REL = "packages/ui";

function toViolation(v: TokenViolation): Violation {
  return { id: v.id, message: v.message };
}

async function formatCss(root: string, relPath: string, content: string): Promise<string> {
  const filepath = path.join(root, relPath);
  const config = await prettier.resolveConfig(filepath);
  return prettier.format(content, { ...config, filepath });
}

function readUtf8(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function extractTokenPropertyNames(tokensCss: string): string[] {
  const names = new Set<string>();
  const pattern = /(--[a-z0-9-]+)\s*:/g;
  for (const match of tokensCss.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return [...names];
}

function extractThemePropertyNames(themeCss: string): string[] {
  const names = new Set<string>();
  const themeStart = themeCss.indexOf("@theme inline {");
  if (themeStart === -1) {
    return [];
  }
  const block = themeCss.slice(themeStart);
  const pattern = /(--[a-z0-9-]+)\s*:/g;
  for (const match of block.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return [...names];
}

function collectUiSourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectUiSourceFiles(full, out);
    } else if (
      entry.isFile() &&
      /\.(tsx?|jsx?|css)$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
}

function unknownVarViolations(
  root: string,
  tokensCss: string,
  themeCss: string,
): Violation[] {
  const known = new Set<string>([
    ...extractTokenPropertyNames(tokensCss),
    ...extractThemePropertyNames(themeCss),
  ]);
  const uiDir = path.join(root, UI_SRC_REL);
  const files: string[] = [];
  collectUiSourceFiles(uiDir, files);
  const hits: Violation[] = [];
  const reported = new Set<string>();
  const varPattern = /var\(\s*(--[a-z0-9-]+)\s*\)/g;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(varPattern)) {
      const name = match[1];
      if (name === undefined || known.has(name) || reported.has(name)) {
        continue;
      }
      reported.add(name);
      const rel = path.relative(root, file);
      hits.push({
        id: "unknown-var",
        message: `Unknown CSS variable ${name} in ${rel}`,
      });
    }
  }
  return hits;
}

export async function check(root: string): Promise<CheckResult> {
  const tokensJsonPath = path.join(root, TOKENS_JSON_REL);
  const tokensCssPath = path.join(root, TOKENS_CSS_REL);
  const themeCssPath = path.join(root, THEME_CSS_REL);

  if (!fs.existsSync(tokensJsonPath)) {
    return {
      ok: false,
      violations: [
        {
          id: "missing-tokens",
          message: `${TOKENS_JSON_REL} is absent`,
        },
      ],
    };
  }

  const rawJson = fs.readFileSync(tokensJsonPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      ok: false,
      violations: [
        {
          id: "invalid-tokens",
          message: `${TOKENS_JSON_REL} is not valid JSON`,
        },
      ],
    };
  }

  const schemaViolations = validateTokens(parsed);
  if (schemaViolations.length > 0) {
    return {
      ok: false,
      violations: schemaViolations.map(toViolation),
    };
  }

  const generated = generateTokens(parsed);
  const formattedTokensCss = await formatCss(root, TOKENS_CSS_REL, generated.tokensCss);
  const formattedThemeCss = await formatCss(root, THEME_CSS_REL, generated.themeCss);

  const committedTokensCss = readUtf8(tokensCssPath);
  const committedThemeCss = readUtf8(themeCssPath);

  const violations: Violation[] = [];

  if (committedTokensCss === null || committedTokensCss !== formattedTokensCss) {
    violations.push({
      id: "drift-tokens",
      message: `${TOKENS_CSS_REL} does not match generated output`,
    });
  }

  if (committedThemeCss === null || committedThemeCss !== formattedThemeCss) {
    violations.push({
      id: "drift-theme",
      message: `${THEME_CSS_REL} does not match generated output`,
    });
  }

  violations.push(
    ...contrastViolations(parsed).map(toViolation),
    ...missingPairViolations(parsed).map(toViolation),
    ...namespaceViolations(extractTokenPropertyNames(formattedTokensCss)).map(toViolation),
    ...selfReferenceViolations(formattedThemeCss).map(toViolation),
    ...unknownVarViolations(root, formattedTokensCss, formattedThemeCss),
  );

  return {
    ok: violations.length === 0,
    violations,
  };
}
