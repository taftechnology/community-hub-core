import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "communities.ts"),
  "utf8",
);

describe("listCommunityIds source", () => {
  it("does not set a session variable or read a slug", () => {
    expect(source).not.toContain("set_config");
    expect(source).not.toContain("slug");
  });
});
