import { describe, expect, it } from "vitest";
import { createLocalKmsPort } from "@community-hub/crypto/testing";

import type { CommunityFieldAad } from "./aad.js";
import { decrypt, encrypt } from "./encrypt.js";
import { deriveKeys } from "./hkdf.js";
import { generateKmsRoot, unwrapKmsRoot, type KmsContext, type KmsPort } from "./index.js";
import { fromHex, toHex } from "../test/vectors/bytes.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

const ORG_CTX: KmsContext = {
  key_kind: "org",
  org_id: "org-1",
  key_version: "v1",
};

const IDENTITY_CTX: KmsContext = {
  key_kind: "identity",
  region: "au",
  key_version: "v1",
};

function fieldAad(): CommunityFieldAad {
  return {
    tag: "chub/field/v1",
    label: "people.email",
    rowId: fromHex("018f0000000000000000000000000002"),
    communityId: fromHex("018f0000000000000000000000000003"),
  };
}

async function assertCanEncryptWithBoth(a: CryptoKey, b: CryptoKey): Promise<void> {
  const { enc: encA } = await deriveKeys(a);
  const { enc: encB } = await deriveKeys(b);
  const plaintext = utf8("kms-root-field");
  const keyId = fromHex("018f00000000000000000000000000aa");
  const aad = fieldAad();
  const blob = await encrypt(encA, plaintext, keyId, aad);
  const opened = await decrypt(blob, () => encB, aad);
  expect(toHex(opened)).toBe(toHex(plaintext));
}

function expectNoPersonalData(err: unknown, ...identifiers: string[]): void {
  const message = err instanceof Error ? err.message : String(err);
  for (const id of identifiers) {
    expect(message).not.toContain(id);
  }
}

async function expectDeriveBitsRejected(key: CryptoKey): Promise<void> {
  await expect(
    crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: new TextEncoder().encode("chub/v1/enc"),
      },
      key,
      256,
    ),
  ).rejects.toThrow();
}

describe("generateKmsRoot / unwrapKmsRoot", () => {
  it("round-trips an org root against the local adapter and returns a non-extractable HKDF key", async () => {
    const port = createLocalKmsPort();
    const generated = await generateKmsRoot(port, "kms-key-1", ORG_CTX);
    expect(Object.keys(generated).sort()).toEqual(["blob", "hkdfKey"]);
    expect(generated).not.toHaveProperty("plaintext");
    expect(generated.hkdfKey.algorithm).toMatchObject({ name: "HKDF" });
    await expect(crypto.subtle.exportKey("raw", generated.hkdfKey)).rejects.toThrow();
    await expectDeriveBitsRejected(generated.hkdfKey);

    const unwrapped = await unwrapKmsRoot(port, "kms-key-1", generated.blob, ORG_CTX);
    expect(unwrapped.algorithm).toMatchObject({ name: "HKDF" });
    await expect(crypto.subtle.exportKey("raw", unwrapped)).rejects.toThrow();
    await expectDeriveBitsRejected(unwrapped);
    await assertCanEncryptWithBoth(generated.hkdfKey, unwrapped);
  });

  it("round-trips an identity root without calling generateDataKey from the test body", async () => {
    const port = createLocalKmsPort();
    const { blob, hkdfKey } = await generateKmsRoot(port, "kms-key-id", IDENTITY_CTX);
    const unwrapped = await unwrapKmsRoot(port, "kms-key-id", blob, IDENTITY_CTX);
    await assertCanEncryptWithBoth(hkdfKey, unwrapped);
  });

  it("zeros generateDataKey plaintext before returning", async () => {
    const inner = createLocalKmsPort();
    let captured: Uint8Array | undefined;
    const port: KmsPort = {
      async generateDataKey(keyId, context) {
        const result = await inner.generateDataKey(keyId, context);
        captured = result.plaintext;
        return result;
      },
      decrypt: (keyId, blob, context) => inner.decrypt(keyId, blob, context),
    };

    await generateKmsRoot(port, "kms-key-1", ORG_CTX);
    expect(captured).toBeDefined();
    expect(captured!.byteLength).toBe(32);
    expect([...captured!].every((b) => b === 0)).toBe(true);
  });

  it("zeros decrypt plaintext before returning", async () => {
    const inner = createLocalKmsPort();
    const { blob } = await generateKmsRoot(inner, "kms-key-1", ORG_CTX);
    let captured: Uint8Array | undefined;
    const port: KmsPort = {
      generateDataKey: (keyId, context) => inner.generateDataKey(keyId, context),
      async decrypt(keyId, wrapped, context) {
        const plaintext = await inner.decrypt(keyId, wrapped, context);
        captured = plaintext;
        return plaintext;
      },
    };

    await unwrapKmsRoot(port, "kms-key-1", blob, ORG_CTX);
    expect(captured).toBeDefined();
    expect([...captured!].every((b) => b === 0)).toBe(true);
  });

  it("fails unwrap with a different keyId, context, or tampered blob without leaking identifiers", async () => {
    const port = createLocalKmsPort();
    const { blob } = await generateKmsRoot(port, "kms-key-1", ORG_CTX);

    await expect(unwrapKmsRoot(port, "kms-key-other", blob, ORG_CTX)).rejects.toThrow();
    await expect(unwrapKmsRoot(port, "kms-key-1", blob, IDENTITY_CTX)).rejects.toThrow();
    await expect(
      unwrapKmsRoot(port, "kms-key-1", blob, { ...ORG_CTX, org_id: "org-2" }),
    ).rejects.toThrow();

    const tampered = new Uint8Array(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    await expect(unwrapKmsRoot(port, "kms-key-1", tampered, ORG_CTX)).rejects.toThrow();

    try {
      await unwrapKmsRoot(port, "kms-key-1", blob, IDENTITY_CTX);
      expect.unreachable();
    } catch (err) {
      expectNoPersonalData(err, "org-1", "au");
    }
  });

  it("rejects generateDataKey plaintext that is not 32 bytes", async () => {
    const inner = createLocalKmsPort();
    const port: KmsPort = {
      async generateDataKey() {
        return { plaintext: new Uint8Array(16), blob: new Uint8Array(8) };
      },
      decrypt: (keyId, blob, context) => inner.decrypt(keyId, blob, context),
    };
    await expect(generateKmsRoot(port, "kms-key-1", ORG_CTX)).rejects.toThrow(/32 bytes/);
  });

  it("rejects decrypt plaintext that is not 32 bytes", async () => {
    const inner = createLocalKmsPort();
    const { blob } = await generateKmsRoot(inner, "kms-key-1", ORG_CTX);
    const port: KmsPort = {
      generateDataKey: (keyId, context) => inner.generateDataKey(keyId, context),
      async decrypt() {
        return new Uint8Array(16);
      },
    };
    await expect(unwrapKmsRoot(port, "kms-key-1", blob, ORG_CTX)).rejects.toThrow(/32 bytes/);
  });
});
