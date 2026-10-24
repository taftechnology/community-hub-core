import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PLATFORM_ROLE_KEYS } from "./role.js";

const IDENTITY_ROLES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../identity/domain/platform-roles.ts",
);

describe("platform roles mirror", () => {
  it("mirrors PLATFORM_ROLE_KEYS in identity", () => {
    const text = readFileSync(IDENTITY_ROLES_PATH, "utf8");
    const arrayMatch = text.match(/PLATFORM_ROLE_KEYS\s*=\s*\[([\s\S]*?)\]/);
    expect(arrayMatch).not.toBeNull();
    const arrayBody = arrayMatch?.[1] ?? "";
    const literals = Array.from(arrayBody.matchAll(/"([^"]+)"|'([^']+)'/g)).map(
      (m) => m[1] ?? m[2] ?? "",
    );
    expect(literals).toEqual([...PLATFORM_ROLE_KEYS]);
  });
});
