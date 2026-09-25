import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALIAS_MARKERS = [
  'from "@/',
  "from '@/",
  'import "@/',
  "import '@/",
  'import("@/',
  "import('@/",
] as const;

export function aliasViolations(source: string): string[] {
  const hits: string[] = [];
  for (const line of source.split("\n")) {
    if (ALIAS_MARKERS.some((marker) => line.includes(marker))) {
      hits.push(line);
    }
  }
  return hits;
}

function shouldScanFile(name: string): boolean {
  if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) {
    return false;
  }
  if (name === "alias.ts") {
    return false;
  }
  return true;
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

export function aliasViolationsInSrc(srcDirectory: URL): string[] {
  const root = fileURLToPath(srcDirectory);
  const files = collectSourceFiles(root);
  if (files.length === 0) {
    throw new Error("aliasViolationsInSrc: no source files to scan");
  }
  const hits: string[] = [];
  for (const file of files) {
    hits.push(...aliasViolations(readFileSync(file, "utf8")));
  }
  return hits;
}
