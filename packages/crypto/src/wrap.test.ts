import { describe, expect, it } from "vitest";

import { encodeAad, type CommunityFieldAad, type WrapAad } from "./aad.js";
import { decrypt, encrypt } from "./encrypt.js";
import { deriveKeys, importHkdfKey } from "./hkdf.js";
import { sealWith } from "./seal.js";
import { generateAndWrap, unwrapKey } from "./wrap.js";
import { fromHex, toHex } from "../test/vectors/bytes.js";
import { wrapV1 } from "../test/vectors/wrap-v1.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

const PARENT_IKM = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const OTHER_IKM = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

function wrapAad(overrides: Partial<WrapAad> = {}): WrapAad {
  return {
    tag: "chub/wrap/v1",
    childKind: "community",
    childId: fromHex("018f0000000000000000000000000010"),
    childKeyId: fromHex("018f0000000000000000000000000011"),
    parentKeyId: fromHex("018f0000000000000000000000000012"),
    ...overrides,
  };
}

function fieldAad(): CommunityFieldAad {
  return {
    tag: "chub/field/v1",
    label: "people.email",
    rowId: fromHex("018f0000000000000000000000000002"),
    communityId: fromHex("018f0000000000000000000000000003"),
  };
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function parentKeys(ikmHex: string) {
  return deriveKeys(await importHkdfKey(fromHex(ikmHex)));
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

async function assertCanEncryptField(hkdfKey: CryptoKey): Promise<void> {
  const { enc } = await deriveKeys(hkdfKey);
  const plaintext = utf8("wrap-child-field");
  const keyId = fromHex("018f00000000000000000000000000aa");
  const aad = fieldAad();
  const blob = await encrypt(enc, plaintext, keyId, aad);
  const opened = await decrypt(blob, () => enc, aad);
  expect(toHex(opened)).toBe(toHex(plaintext));
}

describe("sealWith frozen 0x01 wrap vector", () => {
  it("emits the frozen wrap envelope bytes", async () => {
    const key = await importAesKey(fromHex(wrapV1.keyHex));
    const aad = wrapAad({
      childKind: wrapV1.childKind,
      childId: fromHex(wrapV1.childIdHex),
      childKeyId: fromHex(wrapV1.childKeyIdHex),
      parentKeyId: fromHex(wrapV1.parentKeyIdHex),
    });
    const blob = await sealWith({
      key,
      plaintext: fromHex(wrapV1.rootHex),
      keyId: fromHex(wrapV1.childKeyIdHex),
      iv: fromHex(wrapV1.ivHex),
      boundFields: encodeAad(aad),
    });
    expect(toHex(encodeAad(aad))).toBe(wrapV1.boundFieldsHex);
    expect(toHex(blob)).toBe(wrapV1.envelopeHex);
  });
});

describe("generateAndWrap / unwrapKey", () => {
  it("wrap then unwrap with the same WrapAad yields a key that can encrypt", async () => {
    const { wrap } = await parentKeys(PARENT_IKM);
    const aad = wrapAad();
    const result = await generateAndWrap(wrap, aad);
    expect(Object.keys(result).sort()).toEqual(["blob", "childHkdfKey"]);
    const { blob, childHkdfKey } = result;
    await expect(crypto.subtle.exportKey("raw", childHkdfKey)).rejects.toThrow();
    await expectDeriveBitsRejected(childHkdfKey);

    await assertCanEncryptField(childHkdfKey);

    const unwrapped = await unwrapKey(blob, wrap, aad);
    await expect(crypto.subtle.exportKey("raw", unwrapped)).rejects.toThrow();
    await expectDeriveBitsRejected(unwrapped);
    await assertCanEncryptField(unwrapped);
  });

  it("fails OperationError for the wrong parent wrap key", async () => {
    const { wrap } = await parentKeys(PARENT_IKM);
    const { wrap: otherWrap } = await parentKeys(OTHER_IKM);
    const aad = wrapAad();
    const { blob } = await generateAndWrap(wrap, aad);
    try {
      await unwrapKey(blob, otherWrap, aad);
      expect.unreachable("expected OperationError");
    } catch (err) {
      expectOperationError(err);
      expectNoSecrets(err, fromHex(wrapV1.rootHex), fromHex(PARENT_IKM));
      expectNoSecrets(err, fromHex(wrapV1.rootHex), fromHex(OTHER_IKM));
    }
  });

  it("rejects a blob wrapped under an older childKeyId/parentKeyId (rollback)", async () => {
    const { wrap } = await parentKeys(PARENT_IKM);
    const oldAad = wrapAad({
      childKeyId: fromHex("018f00000000000000000000000000c1"),
      parentKeyId: fromHex("018f00000000000000000000000000d1"),
    });
    const currentAad = wrapAad({
      childKeyId: fromHex("018f00000000000000000000000000c2"),
      parentKeyId: fromHex("018f00000000000000000000000000d2"),
    });
    const { blob } = await generateAndWrap(wrap, oldAad);
    try {
      await unwrapKey(blob, wrap, currentAad);
      expect.unreachable("expected OperationError");
    } catch (err) {
      expectOperationError(err);
      expectNoSecrets(err, fromHex(wrapV1.rootHex), fromHex(PARENT_IKM));
    }
  });

  it("fails OperationError when unwrapping a wrap blob with the enc key", async () => {
    const { wrap, enc } = await parentKeys(PARENT_IKM);
    const aad = wrapAad();
    const { blob } = await generateAndWrap(wrap, aad);
    try {
      await unwrapKey(blob, enc, aad);
      expect.unreachable("expected OperationError");
    } catch (err) {
      expectOperationError(err);
      expectNoSecrets(err, fromHex(wrapV1.rootHex), fromHex(PARENT_IKM));
    }
  });

  it("fails OperationError for the wrong WrapAad fields", async () => {
    const { wrap } = await parentKeys(PARENT_IKM);
    const aad = wrapAad();
    const { blob } = await generateAndWrap(wrap, aad);
    const wrongs: WrapAad[] = [
      wrapAad({ childKind: "household" }),
      wrapAad({ childId: fromHex("018f00000000000000000000000000ff") }),
      wrapAad({ childKeyId: fromHex("018f00000000000000000000000000ee") }),
      wrapAad({ parentKeyId: fromHex("018f00000000000000000000000000dd") }),
    ];
    for (const wrong of wrongs) {
      try {
        await unwrapKey(blob, wrap, wrong);
        expect.unreachable("expected OperationError");
      } catch (err) {
        expectOperationError(err);
        expectNoSecrets(err, fromHex(wrapV1.rootHex), fromHex(PARENT_IKM));
      }
    }
  });

  it("unwraps the frozen wrap vector into a key that can encrypt", async () => {
    const wrapKey = await importAesKey(fromHex(wrapV1.keyHex));
    const aad = wrapAad({
      childKind: wrapV1.childKind,
      childId: fromHex(wrapV1.childIdHex),
      childKeyId: fromHex(wrapV1.childKeyIdHex),
      parentKeyId: fromHex(wrapV1.parentKeyIdHex),
    });
    const unwrapped = await unwrapKey(fromHex(wrapV1.envelopeHex), wrapKey, aad);
    await expect(crypto.subtle.exportKey("raw", unwrapped)).rejects.toThrow();
    await expectDeriveBitsRejected(unwrapped);
    await assertCanEncryptField(unwrapped);
  });
});
