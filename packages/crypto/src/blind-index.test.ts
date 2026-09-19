import { describe, expect, it } from "vitest";

import { blindIndex, type BlindIndex } from "./blind-index.js";
import { deriveKeys, importHkdfKey } from "./hkdf.js";
import { fromHex, toHex } from "../test/vectors/bytes.js";
import { rfc4231Case1 } from "../test/vectors/rfc4231.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

function hmacMessage(purpose: string, normalised: Uint8Array): Uint8Array {
  const purposeBytes = utf8(purpose);
  const out = new Uint8Array(purposeBytes.byteLength + 1 + normalised.byteLength);
  out.set(purposeBytes, 0);
  out[purposeBytes.byteLength] = 0x00;
  out.set(normalised, purposeBytes.byteLength + 1);
  return out;
}

async function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function eq<P extends string>(left: BlindIndex<P>, right: NoInfer<BlindIndex<P>>): boolean {
  return toHex(left) === toHex(right);
}

describe("HMAC-SHA-256 primitive", () => {
  it("matches RFC 4231 Test Case 1", async () => {
    const key = await importHmacKey(fromHex(rfc4231Case1.keyHex));
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(rfc4231Case1.data)));
    expect(mac.byteLength).toBe(32);
    expect(toHex(mac)).toBe(rfc4231Case1.macHex);
  });
});

describe("blindIndex", () => {
  it("returns the 32-byte HMAC of purpose || 0x00 || normalised", async () => {
    const key = await importHmacKey(fromHex(rfc4231Case1.keyHex));
    const purpose = "people.email";
    const normalised = utf8("user@example.com");
    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, hmacMessage(purpose, normalised)),
    );

    const index = await blindIndex(key, purpose, normalised);

    expect(index.byteLength).toBe(32);
    expect(toHex(index)).toBe(toHex(expected));
    expect(toHex(expected)).toHaveLength(64);
  });

  it("throws when purpose contains NUL", async () => {
    const key = await importHmacKey(fromHex(rfc4231Case1.keyHex));
    await expect(blindIndex(key, "people\0email", utf8("user@example.com"))).rejects.toThrow();
  });

  it("differs for the same key and bytes under different purposes", async () => {
    const key = await importHmacKey(fromHex(rfc4231Case1.keyHex));
    const normalised = utf8("user@example.com");
    const email = await blindIndex(key, "people.email", normalised);
    const phone = await blindIndex(key, "people.phone", normalised);
    expect(toHex(email)).not.toBe(toHex(phone));
    expect(eq(email, email)).toBe(true);
    // @ts-expect-error email-index vs phone-index eq does not compile
    eq(email, phone);
  });

  it("signs with the derived bidx HMAC key and rejects the enc AES key", async () => {
    const ikm = fromHex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
    const { enc, bidx } = await deriveKeys(await importHkdfKey(ikm));
    const normalised = utf8("user@example.com");

    const index = await blindIndex(bidx, "people.email", normalised);
    expect(index.byteLength).toBe(32);

    await expect(blindIndex(enc, "people.email", normalised)).rejects.toThrow();
    await expect(
      crypto.subtle.sign("HMAC", enc, hmacMessage("people.email", normalised)),
    ).rejects.toThrow();
  });
});
