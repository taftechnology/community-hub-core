import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV = path.resolve(MODULE, "../../../infra/regions/au/env");

function typescriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...typescriptFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("people boundaries", () => {
  it("does not import tenancy or identity", () => {
    const banned = ["@community-hub/" + "tenancy", "@community-hub/" + "identity"];
    const hits = typescriptFiles(MODULE).filter((file) => {
      const text = readFileSync(file, "utf8");
      return banned.some((name) => text.includes(name));
    });
    expect(hits).toEqual([]);
  });

  it("does not import groups (pin 26)", () => {
    const banned = ["@community-hub/" + "groups"];
    const hits = typescriptFiles(MODULE).filter((file) => {
      const text = readFileSync(file, "utf8");
      return banned.some((name) => text.includes(name));
    });
    expect(hits).toEqual([]);
  });

  it("leaves staging parked", () => {
    const staging = readFileSync(path.join(ENV, "staging.tfvars"), "utf8");
    expect(staging).toMatch(/enable_database\s*=\s*false/);
    expect(staging).toMatch(/desired_count\s*=\s*0/);
    for (const name of readdirSync(ENV)) {
      const full = path.join(ENV, name);
      if (!statSync(full).isFile()) {
        continue;
      }
      expect(readFileSync(full, "utf8")).not.toContain("service_image");
    }
  });
});
