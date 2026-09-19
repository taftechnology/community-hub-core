import { describe, expect, it } from "vitest";
import { createLocalKmsPort, sealWith } from "@community-hub/crypto/testing";

import { encodeAad, type CommunityFieldAad } from "./aad.js";
import type { KmsContext } from "./index.js";
import { fromHex, toHex } from "../test/vectors/bytes.js";
import { fieldV1 } from "../test/vectors/field-v1.js";

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

function expectNoPersonalData(err: unknown, ...identifiers: string[]): void {
  const message = err instanceof Error ? err.message : String(err);
  for (const id of identifiers) {
    expect(message).not.toContain(id);
  }
}

async function expectInvalidContext(
  run: () => Promise<unknown>,
  ...identifiers: string[]
): Promise<void> {
  await expect(run()).rejects.toThrow();
  try {
    await run();
    expect.unreachable();
  } catch (err) {
    expectNoPersonalData(err, ...identifiers);
  }
}

describe("createLocalKmsPort", () => {
  it("round-trips generateDataKey / decrypt with matching keyId and context", async () => {
    const port = createLocalKmsPort();
    const { plaintext, blob } = await port.generateDataKey("kms-key-1", ORG_CTX);
    expect(plaintext.byteLength).toBe(32);
    const opened = await port.decrypt("kms-key-1", blob, ORG_CTX);
    expect(toHex(opened)).toBe(toHex(plaintext));
  });

  it("rejects extra context keys", async () => {
    const port = createLocalKmsPort();
    const extra = {
      key_kind: "org" as const,
      org_id: "org-1",
      key_version: "v1",
      extra: "nope",
    } as unknown as KmsContext;
    await expectInvalidContext(() => port.generateDataKey("kms-key-1", extra), "org-1", "nope");
  });

  it("rejects key_kind org with only region at runtime", async () => {
    const port = createLocalKmsPort();
    const onlyRegion = {
      key_kind: "org" as const,
      region: "au",
      key_version: "v1",
    } as unknown as KmsContext;
    await expectInvalidContext(() => port.generateDataKey("kms-key-1", onlyRegion), "au");
  });

  it("rejects both org_id and region when someone casts", async () => {
    const port = createLocalKmsPort();
    const both = {
      key_kind: "org" as const,
      org_id: "org-1",
      region: "au",
      key_version: "v1",
    } as unknown as KmsContext;
    await expectInvalidContext(() => port.generateDataKey("kms-key-1", both), "org-1", "au");
    await expectInvalidContext(
      () => port.decrypt("kms-key-1", new Uint8Array(12), both),
      "org-1",
      "au",
    );
  });

  it("rejects a context with neither org_id nor region", async () => {
    const port = createLocalKmsPort();
    const neither = {
      key_kind: "org" as const,
      key_version: "v1",
    } as unknown as KmsContext;
    await expectInvalidContext(() => port.generateDataKey("kms-key-1", neither));
    const neitherIdentity = {
      key_kind: "identity" as const,
      key_version: "v1",
    } as unknown as KmsContext;
    await expectInvalidContext(() => port.generateDataKey("kms-key-1", neitherIdentity));
  });

  it("rejects a tampered blob and a wrong keyId", async () => {
    const port = createLocalKmsPort();
    const { blob } = await port.generateDataKey("kms-key-1", ORG_CTX);
    const tampered = new Uint8Array(blob);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await expect(port.decrypt("kms-key-1", tampered, ORG_CTX)).rejects.toThrow();
    await expect(port.decrypt("kms-key-other", blob, ORG_CTX)).rejects.toThrow();
    await expect(port.decrypt("kms-key-1", blob, IDENTITY_CTX)).rejects.toThrow();
  });
});

describe("testing sealWith wrapper", () => {
  it("delegates to production sealWith for the frozen field vector", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      fromHex(fieldV1.keyHex),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const aad: CommunityFieldAad = {
      tag: "chub/field/v1",
      label: fieldV1.label,
      rowId: fromHex(fieldV1.rowIdHex),
      communityId: fromHex(fieldV1.communityIdHex),
    };
    const blob = await sealWith({
      key,
      plaintext: fromHex(fieldV1.plaintextHex),
      keyId: fromHex(fieldV1.keyIdHex),
      iv: fromHex(fieldV1.ivHex),
      boundFields: encodeAad(aad),
    });
    expect(toHex(blob)).toBe(fieldV1.envelopeHex);
  });
});
