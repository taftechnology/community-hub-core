import { describe, expect, it } from "vitest";

import { auditEventHash, auditEventPreimage, type AuditHashInput } from "./audit-hash.js";

const FROZEN_DIGEST_HEX = "7a29119e629b70f9d9ff4ef69ebc874303ee4315a745f306cbddb802c129b5ad";

const frozenInput: AuditHashInput = {
  hashVersion: 1,
  orgId: "00000000-0000-7000-8000-000000000001",
  id: "00000000-0000-7000-8000-000000000002",
  seq: 1n,
  prevHash: new Uint8Array(32),
  actorKind: "user",
  actorId: "00000000-0000-7000-8000-000000000003",
  action: "audit.chain.recorded",
  targetIds: [],
  purpose: "audit.chain.test",
  requestId: "00000000-0000-7000-8000-000000000004",
  occurredAtMicros: 1767225600000000n,
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("auditEventHash", () => {
  it("matches the frozen digest for the spec vector", async () => {
    const digest = await auditEventHash(frozenInput);
    expect(toHex(digest)).toBe(FROZEN_DIGEST_HEX);
  });

  it("changes the digest when only actorKind changes", async () => {
    const base = await auditEventHash(frozenInput);
    const support = await auditEventHash({ ...frozenInput, actorKind: "support" });
    expect(toHex(support)).not.toBe(toHex(base));
  });

  it("encodes null actorId as length 0, distinct from a 16-byte actor", async () => {
    const withActor = await auditEventHash(frozenInput);
    const nullActor = await auditEventHash({
      ...frozenInput,
      actorKind: "system",
      actorId: null,
    });
    expect(toHex(nullActor)).not.toBe(toHex(withActor));
  });

  it("produces a different digest when microseconds are floored to the millisecond", async () => {
    const value = 1767225600000001n;
    expect(value % 1000n).not.toBe(0n);
    const floored = value - (value % 1000n);
    const precise = await auditEventHash({ ...frozenInput, occurredAtMicros: value });
    const msOnly = await auditEventHash({ ...frozenInput, occurredAtMicros: floored });
    expect(toHex(precise)).not.toBe(toHex(msOnly));
  });
});

describe("auditEventPreimage", () => {
  it("returns Uint8Array synchronously", () => {
    const preimage = auditEventPreimage(frozenInput);
    expect(preimage).toBeInstanceOf(Uint8Array);
    expect(preimage[0]).toBe(0x01);
  });
});
