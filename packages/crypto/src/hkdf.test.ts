import { describe, expect, it } from "vitest";

import { deriveKeys, hkdfRaw, importHkdfKey } from "./hkdf.js";
import { fromHex, toHex } from "../test/vectors/bytes.js";
import { rfc5869A3 } from "../test/vectors/rfc5869-a3.js";

describe("hkdfRaw", () => {
  it("matches RFC 5869 Appendix A.3 with empty salt and info", async () => {
    const okm = await hkdfRaw(
      fromHex(rfc5869A3.ikmHex),
      fromHex(rfc5869A3.saltHex),
      fromHex(rfc5869A3.infoHex),
      rfc5869A3.lengthBytes,
    );
    expect(toHex(okm)).toBe(rfc5869A3.okmHex);
  });

  it("treats 32 zero bytes of salt as empty salt for A.3", async () => {
    const fromEmpty = await hkdfRaw(
      fromHex(rfc5869A3.ikmHex),
      new Uint8Array(0),
      new Uint8Array(0),
      rfc5869A3.lengthBytes,
    );
    const fromZeros = await hkdfRaw(
      fromHex(rfc5869A3.ikmHex),
      new Uint8Array(32),
      new Uint8Array(0),
      rfc5869A3.lengthBytes,
    );
    expect(toHex(fromEmpty)).toBe(rfc5869A3.okmHex);
    expect(toHex(fromZeros)).toBe(rfc5869A3.okmHex);
  });
});

describe("deriveKeys", () => {
  it("splits one root into distinct enc, bidx, and wrap keys of a single purpose each", async () => {
    const ikm = fromHex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
    const root = await importHkdfKey(ikm);
    const { enc, bidx, wrap } = await deriveKeys(root);

    await expect(crypto.subtle.exportKey("raw", enc)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("raw", bidx)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("raw", wrap)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("raw", root)).rejects.toThrow();

    expect(enc.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(wrap.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(bidx.algorithm).toMatchObject({
      name: "HMAC",
      hash: { name: "SHA-256" },
      length: 256,
    });

    expect([...enc.usages].sort()).toEqual(["decrypt", "encrypt"]);
    expect([...wrap.usages].sort()).toEqual(["decrypt", "encrypt"]);
    expect(bidx.usages).toEqual(["sign"]);

    const encBits = await hkdfRaw(
      ikm,
      new Uint8Array(0),
      new TextEncoder().encode("chub/v1/enc"),
      32,
    );
    const bidxBits = await hkdfRaw(
      ikm,
      new Uint8Array(0),
      new TextEncoder().encode("chub/v1/bidx"),
      32,
    );
    const wrapBits = await hkdfRaw(
      ikm,
      new Uint8Array(0),
      new TextEncoder().encode("chub/v1/wrap"),
      32,
    );
    expect(toHex(encBits)).not.toBe(toHex(bidxBits));
    expect(toHex(encBits)).not.toBe(toHex(wrapBits));
    expect(toHex(bidxBits)).not.toBe(toHex(wrapBits));

    const iv = new Uint8Array(12);
    const pt = new Uint8Array([1, 2, 3]);
    const sealedWithEnc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, enc, pt);
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, wrap, sealedWithEnc),
    ).rejects.toThrow();
  });
});
