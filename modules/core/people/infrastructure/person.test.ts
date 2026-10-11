import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function needles(): string[] {
  return ["set_" + "config", "where email " + "=", "order " + "by", "group " + "by"];
}

describe("person source", () => {
  it("does not set tenant config or query ciphertext", () => {
    const files = readdirSync(DIRECTORY).filter((name) => name.endsWith(".ts"));
    const banned = needles();
    const hits = files.filter((name) => {
      const text = readFileSync(path.join(DIRECTORY, name), "utf8").toLowerCase();
      return banned.some((needle) => text.includes(needle));
    });
    expect(hits).toEqual([]);
  });
});
