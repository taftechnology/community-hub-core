import fs from "node:fs";
import path from "node:path";

const ZOD = /zod/i;

export type BundleViolation = {
  file: string;
  message: string;
};

export type BundleCheckResult = {
  ok: boolean;
  violations: BundleViolation[];
};

function walk(dir: string, files: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
}

export function check(dir: string): BundleCheckResult {
  const violations: BundleViolation[] = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return {
      ok: false,
      violations: [{ file: dir, message: "output directory has no .js file" }],
    };
  }

  const files: string[] = [];
  walk(dir, files);
  if (!files.some((file) => file.endsWith(".js"))) {
    violations.push({ file: dir, message: "output directory has no .js file" });
  }

  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (ZOD.test(text)) {
      violations.push({ file, message: "bundle contains zod" });
    }
  }

  return { ok: violations.length === 0, violations };
}
