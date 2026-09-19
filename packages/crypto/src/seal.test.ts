import { describe, expect, it } from "vitest";

import { aes256GcmEncrypt } from "./seal.js";
import { fromHex, toHex } from "../test/vectors/bytes.js";
import { nistAes256GcmTc16 } from "../test/vectors/nist-aes-256-gcm.js";

describe("aes256GcmEncrypt", () => {
  it("matches NIST AES-256-GCM Test Case 16", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      fromHex(nistAes256GcmTc16.keyHex),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const out = await aes256GcmEncrypt(
      key,
      fromHex(nistAes256GcmTc16.ivHex),
      fromHex(nistAes256GcmTc16.plaintextHex),
      fromHex(nistAes256GcmTc16.aadHex),
    );
    expect(toHex(out)).toBe(nistAes256GcmTc16.ciphertextHex + nistAes256GcmTc16.tagHex);
  });
});
