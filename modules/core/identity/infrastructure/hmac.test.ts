import type { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

import { hmac } from "./hmac.js";

const SYNTHETIC_KEY = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
]);

const OTP_MESSAGE = new TextEncoder().encode("12345678");
const ACCESS_MESSAGE = new Uint8Array(32).fill(0xaa);
const REFRESH_MESSAGE = new Uint8Array(32).fill(0xbb);

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

async function importKey(raw: Uint8Array): Promise<webcrypto.CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

describe("shared HMAC helper", () => {
  it("matches known-answer vectors for identity.otp, identity.access, and identity.refresh", async () => {
    const key = await importKey(SYNTHETIC_KEY);

    const otpMac = await hmac(key, "identity.otp", OTP_MESSAGE);
    expect(toHex(otpMac)).toBe("e26638de2750674612592b559dff5ddd14a016e217bbd9e491ce9457ccfec138");

    const accessMac = await hmac(key, "identity.access", ACCESS_MESSAGE);
    expect(toHex(accessMac)).toBe(
      "2c0093d7c01bf855a693a40eb102faa2edfcf3d98112111b49e6e9ef47bf7d5f",
    );

    const refreshMac = await hmac(key, "identity.refresh", REFRESH_MESSAGE);
    expect(toHex(refreshMac)).toBe(
      "e93e8b31df93ff41d1197f1152b391b18f76496d5069814e727010b7924be06f",
    );
  });

  it("rejects a label containing NUL", async () => {
    const key = await importKey(SYNTHETIC_KEY);
    await expect(hmac(key, "identity\0bad", OTP_MESSAGE)).rejects.toThrow(
      "label must not contain NUL",
    );
  });
});
