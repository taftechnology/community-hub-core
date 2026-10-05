import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createPlaintextDirectSql } from "../src/plaintext.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SELF = fileURLToPath(import.meta.url);
const FACTORY_IMPORT =
  /(?:^|\n)\s*import\s+(?:type\s+)?[\s\S]*?\sfrom\s+["'][^"']*connections(?:\.js)?["']/g;

function callerFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "dist" || entry === "node_modules") continue;
      found.push(...callerFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || full === SELF) continue;
    const rel = path.relative(ROOT, full);
    if (rel === path.join("src", "index.ts") || rel === path.join("src", "connections.ts")) {
      continue;
    }
    if (rel.startsWith(`test${path.sep}`) || rel === path.join("src", "migrate.ts")) {
      found.push(full);
    }
  }
  return found;
}

describe("plaintext connections", () => {
  it("connects to the compose Postgres without TLS", async () => {
    const sql = createPlaintextDirectSql("postgres://hub:local-bootstrap-only@127.0.0.1:5432/hub");
    try {
      const rows = await sql<{ n: number }[]>`select 1 as n`;
      expect(rows[0]?.n).toBe(1);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("leaves the production factories with no callers", () => {
    const offenders: string[] = [];
    for (const file of callerFiles(ROOT)) {
      const text = readFileSync(file, "utf8");
      if (FACTORY_IMPORT.test(text)) {
        offenders.push(path.relative(ROOT, file));
      }
      FACTORY_IMPORT.lastIndex = 0;
    }
    expect(offenders).toEqual([]);
  });
});
