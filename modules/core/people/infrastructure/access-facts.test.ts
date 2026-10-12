import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "access-facts.ts");

describe("access fact reads", () => {
  it("does not audit, set tenant config, or encrypt", () => {
    const banned = ["appendAudit" + "Event", "set_" + "config", "enc" + "rypt", "dec" + "rypt"];
    const text = readFileSync(SOURCE, "utf8");
    const hits = banned.filter((name) => text.includes(name));
    expect(hits).toEqual([]);
  });
});
