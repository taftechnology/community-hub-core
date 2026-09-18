import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { scramSha256Verifier } from "./scram.js";

const SHAPE = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

describe("scramSha256Verifier", () => {
  it("returns the Postgres SCRAM-SHA-256 rolpassword shape", () => {
    const verifier = scramSha256Verifier("ci-throwaway-password");
    expect(verifier).toMatch(SHAPE);
  });

  it("is deterministic for the same password, salt and iterations", () => {
    const salt = randomBytes(16);
    const a = scramSha256Verifier("same-secret", { salt, iterations: 4096 });
    const b = scramSha256Verifier("same-secret", { salt, iterations: 4096 });
    expect(a).toBe(b);
  });

  it("stores HMAC-SHA-256 StoredKey and ServerKey for the salt", () => {
    const salt = Buffer.from("c2FsdHNhbHRzYWx0", "base64");
    const iterations = 4096;
    const password = "pencil";
    const verifier = scramSha256Verifier(password, { salt, iterations });
    const parts = verifier.split("$");
    expect(parts[0]).toBe("SCRAM-SHA-256");
    const [iter, saltB64] = parts[1]!.split(":");
    const [storedB64, serverB64] = parts[2]!.split(":");
    expect(iter).toBe("4096");
    expect(saltB64).toBe(salt.toString("base64"));

    const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
    const clientKey = hmacSha256(salted, "Client Key");
    const storedKey = createHash("sha256").update(clientKey).digest();
    const serverKey = hmacSha256(salted, "Server Key");
    expect(storedB64).toBe(storedKey.toString("base64"));
    expect(serverB64).toBe(serverKey.toString("base64"));
  });
});

function hmacSha256(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}
