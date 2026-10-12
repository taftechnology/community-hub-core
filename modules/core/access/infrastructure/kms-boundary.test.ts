import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("kms boundary", () => {
  it("does not decrypt or import the crypto testing port", () => {
    const banned = [".decrypt(", "generateDataKey(", 'from "@community-hub/crypto/testing"'];
    const hits = sourceFiles(MODULE).filter((file) => {
      const text = readFileSync(file, "utf8");
      return banned.some((needle) => text.includes(needle));
    });
    expect(hits).toEqual([]);
  });
});
