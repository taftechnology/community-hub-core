import { describe, expect, it } from "vitest";

import { encodeAad } from "./aad.js";
import type { CommunityFieldAad, IdentityFieldAad } from "./aad.js";
import { decrypt, encrypt, type Ciphertext } from "./encrypt.js";
import { sealWith } from "./seal.js";
import { fromHex, toHex } from "../test/vectors/bytes.js";
import { fieldV1 } from "../test/vectors/field-v1.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

function asCiphertext(bytes: Uint8Array): Ciphertext {
  return bytes as Ciphertext;
}

function flip(bytes: Uint8Array, index: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[index] = (copy[index] ?? 0) ^ 0xff;
  return copy;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function communityAad(overrides: Partial<CommunityFieldAad> = {}): CommunityFieldAad {
  return {
    tag: "chub/field/v1",
    label: "people.email",
    rowId: fromHex("018f0000000000000000000000000002"),
    communityId: fromHex("018f0000000000000000000000000003"),
    ...overrides,
  };
}

function identityAad(overrides: Partial<IdentityFieldAad> = {}): IdentityFieldAad {
  return {
    tag: "chub/field-identity/v1",
    label: "people.email",
    rowId: fromHex("018f0000000000000000000000000002"),
    region: "au",
    ...overrides,
  };
}

function expectOperationError(err: unknown): void {
  expect(err).toBeInstanceOf(DOMException);
  expect((err as DOMException).name).toBe("OperationError");
}

function expectNoSecrets(err: unknown, plaintext: Uint8Array, key: Uint8Array): void {
  const message = err instanceof Error ? err.message : String(err);
  expect(message).not.toContain(new TextDecoder().decode(plaintext));
  expect(message.toLowerCase()).not.toContain(toHex(plaintext));
  expect(message.toLowerCase()).not.toContain(toHex(key));
}

describe("sealWith frozen 0x01 field vector", () => {
  it("emits the frozen envelope bytes", async () => {
    const key = await importAesKey(fromHex(fieldV1.keyHex));
    const aad = communityAad({
      label: fieldV1.label,
      rowId: fromHex(fieldV1.rowIdHex),
      communityId: fromHex(fieldV1.communityIdHex),
    });
    const blob = await sealWith({
      key,
      plaintext: fromHex(fieldV1.plaintextHex),
      keyId: fromHex(fieldV1.keyIdHex),
      iv: fromHex(fieldV1.ivHex),
      boundFields: encodeAad(aad),
    });
    expect(toHex(encodeAad(aad))).toBe(fieldV1.boundFieldsHex);
    expect(toHex(blob)).toBe(fieldV1.envelopeHex);
  });
});

describe("encrypt/decrypt", () => {
  const keyId = fromHex("018f0000000000000000000000000001");
  const plaintext = utf8("secret-plaintext-xyz");

  it("round-trips community AAD when decrypt is given the same AAD", async () => {
    const key = await importAesKey(fromHex(fieldV1.keyHex));
    const aad = communityAad();
    const blob = await encrypt(key, plaintext, keyId, aad);
    const opened = await decrypt(blob, () => key, aad);
    expect(toHex(opened)).toBe(toHex(plaintext));
  });

  it("round-trips identity AAD when decrypt is given the same AAD", async () => {
    const key = await importAesKey(fromHex(fieldV1.keyHex));
    const aad = identityAad();
    const blob = await encrypt(key, plaintext, keyId, aad);
    const opened = await decrypt(blob, () => key, aad);
    expect(toHex(opened)).toBe(toHex(plaintext));
  });

  it("throws before GCM when communityId is empty", async () => {
    const key = await importAesKey(fromHex(fieldV1.keyHex));
    await expect(
      encrypt(key, plaintext, keyId, communityAad({ communityId: new Uint8Array(0) })),
    ).rejects.toThrow(/community id/i);
  });

  it("throws before GCM when communityId is omitted", async () => {
    const key = await importAesKey(fromHex(fieldV1.keyHex));
    const aad = {
      tag: "chub/field/v1" as const,
      label: "people.email",
      rowId: fromHex("018f0000000000000000000000000002"),
    };
    await expect(encrypt(key, plaintext, keyId, aad as CommunityFieldAad)).rejects.toThrow(
      /community id/i,
    );
  });

  it("fails OperationError for each header and AAD tamper while the resolver ignores key_id", async () => {
    const key = await importAesKey(fromHex(fieldV1.keyHex));
    const aad = communityAad();
    const blob = await encrypt(key, plaintext, keyId, aad);
    const resolveIgnoringKeyId = () => key;

    const tampers: Uint8Array[] = [
      flip(blob, 0), // version
      flip(blob, 1), // key_id
      flip(blob, 17), // IV
      flip(blob, blob.length - 1), // GCM tag
    ];
    for (const tampered of tampers) {
      try {
        await decrypt(asCiphertext(tampered), resolveIgnoringKeyId, aad);
        expect.unreachable("expected OperationError");
      } catch (err) {
        expectOperationError(err);
        expectNoSecrets(err, plaintext, fromHex(fieldV1.keyHex));
      }
    }

    const aadTampers: CommunityFieldAad[] = [
      communityAad({ label: "people.phone" }),
      communityAad({ rowId: flip(aad.rowId, 0) }),
      communityAad({ communityId: flip(aad.communityId, 0) }),
    ];
    for (const wrong of aadTampers) {
      try {
        await decrypt(blob, resolveIgnoringKeyId, wrong);
        expect.unreachable("expected OperationError");
      } catch (err) {
        expectOperationError(err);
        expectNoSecrets(err, plaintext, fromHex(fieldV1.keyHex));
      }
    }

    const identityBlob = await encrypt(key, plaintext, keyId, identityAad());
    try {
      await decrypt(identityBlob, resolveIgnoringKeyId, identityAad({ region: "us" }));
      expect.unreachable("expected OperationError");
    } catch (err) {
      expectOperationError(err);
      expectNoSecrets(err, plaintext, fromHex(fieldV1.keyHex));
    }
  });
});
