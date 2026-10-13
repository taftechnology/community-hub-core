import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = path.dirname(fileURLToPath(import.meta.url));

function source(name: string): string {
  return readFileSync(path.join(DIR, name), "utf8");
}

describe("identity key source", () => {
  it("does not set a tenant scope or filter the ciphertext column", () => {
    const key = source("identity-key.ts");
    const user = source("identity-user.ts");
    expect(key).not.toMatch(/set_config/);
    expect(key).not.toMatch(/\bSET\b/);
    expect(user).not.toMatch(/set_config/);
    expect(user).not.toMatch(/\bSET\b/);
    expect(user).not.toMatch(/where email/);
  });

  it("looks up identity.users by the blind index only, never the raw email column", () => {
    const lookup = source("email-lookup.ts");
    // The shared helper reads and writes identity.users, so it must only ever
    // filter on the blind index, never on the ciphertext `email` column itself.
    expect(lookup).toMatch(/email_bidx/);
    expect(lookup).not.toMatch(/where email /);
    expect(lookup).not.toMatch(/and email /);
  });
});
