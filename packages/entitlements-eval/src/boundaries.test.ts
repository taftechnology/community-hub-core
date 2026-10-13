import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...files(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("entitlements-eval boundaries", () => {
  it("does not import a database client", () => {
    const banned = ["@community-hub/" + "db", "driz" + "zle", "post" + "gres"];
    const hits = files(PACKAGE).filter((file) => {
      const text = readFileSync(file, "utf8");
      return banned.some((name) => text.includes(name));
    });
    expect(hits).toEqual([]);
  });
});
