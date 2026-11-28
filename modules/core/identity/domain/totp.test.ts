import { describe, expect, it } from "vitest";

import {
  base32Decode,
  base32Encode,
  newTotpKey,
  otpauthUri,
  stepAt,
  totpCode,
  verifyTotp,
} from "./totp.js";

const RFC_6238_KEY = new TextEncoder().encode("12345678901234567890");

describe("totp", () => {
  it("matches the RFC 6238 SHA1 vectors truncated to six digits", () => {
    const vectors = [
      { epochSeconds: 59, expected: "287082" },
      { epochSeconds: 1111111109, expected: "081804" },
      { epochSeconds: 1111111111, expected: "050471" },
      { epochSeconds: 1234567890, expected: "005924" },
      { epochSeconds: 2000000000, expected: "279037" },
      { epochSeconds: 20000000000, expected: "353130" },
    ] as const;

    for (const vector of vectors) {
      const now = new Date(vector.epochSeconds * 1000);
      const step = stepAt(now);
      expect(totpCode(RFC_6238_KEY, step)).toBe(vector.expected);
      expect(verifyTotp(RFC_6238_KEY, vector.expected, now)).toBe(step);
    }
  });

  it("accepts one step either side and refuses two", () => {
    const now = new Date(1234567890 * 1000);
    const step = stepAt(now);

    expect(verifyTotp(RFC_6238_KEY, totpCode(RFC_6238_KEY, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_6238_KEY, totpCode(RFC_6238_KEY, step), now)).toBe(step);
    expect(verifyTotp(RFC_6238_KEY, totpCode(RFC_6238_KEY, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(RFC_6238_KEY, totpCode(RFC_6238_KEY, step - 2), now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, totpCode(RFC_6238_KEY, step + 2), now)).toBeNull();

    const epochStart = new Date(0);
    expect(verifyTotp(RFC_6238_KEY, totpCode(RFC_6238_KEY, 0), epochStart)).toBe(0);
    expect(verifyTotp(RFC_6238_KEY, totpCode(RFC_6238_KEY, 1), epochStart)).toBe(1);
    expect(verifyTotp(RFC_6238_KEY, totpCode(RFC_6238_KEY, 2), epochStart)).toBeNull();

    const current = totpCode(RFC_6238_KEY, step);
    expect(verifyTotp(RFC_6238_KEY, "", now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, current.slice(0, 5), now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, current + "0", now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, "12345a", now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, " " + current.slice(1), now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, "١٢٣٤٥٦", now)).toBeNull();
  });

  it("refuses input that is not six ASCII digits", () => {
    const now = new Date(1234567890 * 1000);
    const current = totpCode(RFC_6238_KEY, stepAt(now));

    expect(verifyTotp(RFC_6238_KEY, "", now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, current.slice(0, 5), now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, "12345", now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, current + "0", now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, "0" + current, now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, "1234567", now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, "12345a", now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, "abcdef", now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, " " + current, now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, current + " ", now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, " " + current.slice(1), now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, current.slice(0, 3) + " " + current.slice(3), now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, "００５９２４", now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, "１２３４５６", now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, "١٢٣٤٥٦", now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, current + "\n", now)).toBeNull();
    expect(verifyTotp(RFC_6238_KEY, "+05924", now)).toBeNull();
  });

  it("keeps leading zeros", () => {
    const stepTwoZeros = stepAt(new Date(1234567890 * 1000));
    expect(totpCode(RFC_6238_KEY, stepTwoZeros)).toBe("005924");
    expect(verifyTotp(RFC_6238_KEY, "005924", new Date(1234567890 * 1000))).toBe(stepTwoZeros);
    expect(verifyTotp(RFC_6238_KEY, "5924", new Date(1234567890 * 1000))).toBeNull();

    const stepOneZero = stepAt(new Date(1111111109 * 1000));
    expect(totpCode(RFC_6238_KEY, stepOneZero)).toBe("081804");
  });

  it("builds the otpauth link with issuer and label Community Hub only", () => {
    const keys = [RFC_6238_KEY, newTotpKey()];
    for (const key of keys) {
      const secret = base32Encode(key);
      const uri = otpauthUri(key);
      expect(uri).toBe(
        `otpauth://totp/Community%20Hub?secret=${secret}&issuer=Community%20Hub&algorithm=SHA1&digits=6&period=30`,
      );
    }
  });

  it("encodes and decodes the RFC 4648 base32 test strings without padding", () => {
    const vectors = [
      { text: "", base32: "" },
      { text: "f", base32: "MY" },
      { text: "fo", base32: "MZXQ" },
      { text: "foo", base32: "MZXW6" },
      { text: "foob", base32: "MZXW6YQ" },
      { text: "fooba", base32: "MZXW6YTB" },
      { text: "foobar", base32: "MZXW6YTBOI" },
    ] as const;

    const encoder = new TextEncoder();
    for (const vector of vectors) {
      const bytes = encoder.encode(vector.text);
      expect(base32Encode(bytes)).toBe(vector.base32);
      expect(base32Decode(vector.base32)).toEqual(bytes);
    }
  });

  it("generates a 20-byte key and round-trips it through base32", () => {
    const first = newTotpKey();
    const second = newTotpKey();
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first.byteLength).toBe(20);
    expect(second.byteLength).toBe(20);
    expect(first).not.toEqual(second);

    const encoded = base32Encode(first);
    expect(encoded).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(encoded)).toEqual(first);
  });

  it("rejects invalid base32 input on decode", () => {
    expect(base32Decode("my")).toBeNull();
    expect(base32Decode("MY======")).toBeNull();
    expect(base32Decode("MZXW6===")).toBeNull();
    expect(base32Decode("MY ZX")).toBeNull();
    expect(base32Decode("0189AAAA")).toBeNull();
    expect(base32Decode("A")).toBeNull();
    expect(base32Decode("ABC")).toBeNull();
    expect(base32Decode("ABCDEF")).toBeNull();
    expect(base32Decode("MZ")).toBeNull();
  });

  it("computes the 30-second step at a timestamp", () => {
    expect(stepAt(new Date(0))).toBe(0);
    expect(stepAt(new Date(29_999))).toBe(0);
    expect(stepAt(new Date(30_000))).toBe(1);
    expect(stepAt(new Date(59_000))).toBe(1);
    expect(stepAt(new Date(60_000))).toBe(2);
  });
});
