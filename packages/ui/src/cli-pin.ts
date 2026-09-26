import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHADCN_SCRIPT_VERSION_RE = /shadcn@(\d+\.\d+\.\d+)/;
const COPIED_HEADER_CLI_RE = /\(CLI (\d+\.\d+\.\d+)\)/;

export function shadcnVersionFromScript(source: string): string | null {
  return source.match(SHADCN_SCRIPT_VERSION_RE)?.[1] ?? null;
}

export function shadcnVersionFromReadme(source: string): string | null {
  return source.match(SHADCN_SCRIPT_VERSION_RE)?.[1] ?? null;
}

export function cliVersionFromCopiedHeader(source: string): string | null {
  const firstLine = source.split("\n", 1)[0] ?? "";
  return firstLine.match(COPIED_HEADER_CLI_RE)?.[1] ?? null;
}

function shouldScanCopiedFile(name: string): boolean {
  if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) {
    return false;
  }
  if (name === "cli-pin.ts") {
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
    if (shouldScanCopiedFile(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

export function copiedHeaderCliVersionsInSrc(srcDirectory: URL): string[] {
  const root = fileURLToPath(srcDirectory);
  const versions: string[] = [];
  for (const file of collectSourceFiles(root)) {
    const version = cliVersionFromCopiedHeader(readFileSync(file, "utf8"));
    if (version !== null) {
      versions.push(version);
    }
  }
  if (versions.length === 0) {
    throw new Error("copiedHeaderCliVersionsInSrc: no copied-file CLI headers found");
  }
  return versions;
}

export function cliPinMismatch(
  scriptVersion: string,
  readmeVersion: string,
  headerVersions: string[],
): boolean {
  if (readmeVersion !== scriptVersion) {
    return true;
  }
  return headerVersions.some((version) => version !== scriptVersion);
}
