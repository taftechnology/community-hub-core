import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPACITY_MODIFIER_PATTERN =
  /(?<![\w-])((?:[a-z0-9_@&:[\]/.-]+:)*(?:bg|ring|border|outline|text|fill)-(?:[\w-]+|\[[^\]]+\])\/(?:\d+|\[[^\]]+\]))(?![\w-])/gi;

export function opacityViolations(source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(OPACITY_MODIFIER_PATTERN)) {
    const token = match[1];
    if (token) {
      hits.push(token);
    }
  }
  return hits;
}

function shouldScanFile(name: string): boolean {
  if (name.includes(".test.") || name.endsWith(".test.ts") || name.endsWith(".test.tsx")) {
    return false;
  }
  if (name === "opacity.ts") {
    return false;
  }
  return name.endsWith(".ts") || name.endsWith(".tsx");
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (shouldScanFile(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

export function opacityViolationsInSrc(srcDirectory: URL): string[] {
  const root = fileURLToPath(srcDirectory);
  const files = collectSourceFiles(root);
  if (files.length === 0) {
    throw new Error("opacityViolationsInSrc: no source files to scan");
  }
  const hits: string[] = [];
  for (const file of files) {
    const fileHits = opacityViolations(readFileSync(file, "utf8"));
    for (const hit of fileHits) {
      hits.push(`${path.relative(root, file)}: ${hit}`);
    }
  }
  return hits;
}
