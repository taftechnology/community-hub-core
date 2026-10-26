import { describe, expect, it } from "vitest";

import { decode, encode } from "./base64url.js";

describe("base64url", () => {
  it("round trips for lengths 0-5 and 32", () => {
    const lengths = [0, 1, 2, 3, 4, 5, 32];
    for (const len of lengths) {
      const original = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        // Deterministic synthetic bytes
        original[i] = (i * 37 + 13) & 0xff;
      }
      const encoded = encode(original);
      expect(encoded).not.toContain("=");
      const decoded = decode(encoded);
      expect(decoded).toEqual(original);

      // Also accepts ArrayBuffer directly in encode
      const encodedFromBuffer = encode(original.buffer);
      expect(encodedFromBuffer).toBe(encoded);
      expect(decode(encodedFromBuffer)).toEqual(original);
    }
  });

  it("decoding accepts padded and unpadded input", () => {
    // Length 1 byte [1] -> standard base64 is "AQ==", base64url is "AQ"
    const oneByte = new Uint8Array([1]);
    expect(decode("AQ")).toEqual(oneByte);
    expect(decode("AQ==")).toEqual(oneByte);

    // Length 2 bytes [1, 2] -> standard base64 is "AQI=", base64url is "AQI"
    const twoBytes = new Uint8Array([1, 2]);
    expect(decode("AQI")).toEqual(twoBytes);
    expect(decode("AQI=")).toEqual(twoBytes);

    // Length 3 bytes [1, 2, 3] -> "AQID"
    const threeBytes = new Uint8Array([1, 2, 3]);
    expect(decode("AQID")).toEqual(threeBytes);
  });

  it("throws on characters outside the alphabet including + and /", () => {
    expect(() => decode("AQ+D")).toThrow();
    expect(() => decode("AQ/D")).toThrow();
    expect(() => decode("AQ!D")).toThrow();
    expect(() => decode("AQ D")).toThrow();
  });

  it("throws on invalid unpadded length (len % 4 === 1)", () => {
    expect(() => decode("A")).toThrow();
    expect(() => decode("AAAAA")).toThrow();
  });
});
