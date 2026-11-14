import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  closeInvitationEmail,
  createInvitationEmail,
  invitationAddressMatches,
  openInvitationEmails,
} from "./invitation-email.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;

function createStubSql() {
  const queryFn = vi.fn().mockRejectedValue(new Error("unexpected query"));
  const beginFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb(queryFn);
  });
  const sql = Object.assign(queryFn, {
    begin: beginFn,
  }) as unknown as Sql;
  return { sql, queryFn, beginFn };
}

describe("invitation-email unit tests", () => {
  it("throws before any query when given 101 ids (pin 17a)", async () => {
    const { sql, queryFn } = createStubSql();
    const kms = createLocalKmsPort();
    const ids = Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );

    await expect(openInvitationEmails(sql, kms, KEY_ARN, ids)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("returns empty map without querying when given 0 ids", async () => {
    const { sql, queryFn } = createStubSql();
    const kms = createLocalKmsPort();

    const result = await openInvitationEmails(sql, kms, KEY_ARN, []);
    expect(result.size).toBe(0);
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("throws before any query when given a non-UUID id in openInvitationEmails", async () => {
    const { sql, queryFn } = createStubSql();
    const kms = createLocalKmsPort();

    await expect(openInvitationEmails(sql, kms, KEY_ARN, ["not-a-uuid"])).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("createInvitationEmail with invalid address throws IdentityError invalid_email and inserts nothing", async () => {
    const { sql, queryFn, beginFn } = createStubSql();
    const kms = createLocalKmsPort();

    await expect(
      createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: "00000000-0000-4000-8000-000000000001",
        communityId: "00000000-0000-4000-8000-000000000002",
        address: "alex@",
        expiresAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "invalid_email" });

    expect(queryFn).not.toHaveBeenCalled();
    expect(beginFn).not.toHaveBeenCalled();
  });

  it("createInvitationEmail with non-UUID ids throws IdentityError invalid_input and inserts nothing", async () => {
    const { sql, queryFn } = createStubSql();
    const kms = createLocalKmsPort();

    await expect(
      createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: "not-a-uuid",
        communityId: "00000000-0000-4000-8000-000000000002",
        address: "alex@example.test",
        expiresAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: "00000000-0000-4000-8000-000000000001",
        communityId: "not-a-uuid",
        address: "alex@example.test",
        expiresAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(queryFn).not.toHaveBeenCalled();
  });

  it("closeInvitationEmail with non-UUID id throws IdentityError invalid_input", async () => {
    const { sql, queryFn } = createStubSql();

    await expect(closeInvitationEmail(sql, "not-a-uuid")).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("invitationAddressMatches with non-UUID ids returns false without querying", async () => {
    const { sql, queryFn } = createStubSql();

    const r1 = await invitationAddressMatches(sql, {
      invitationId: "not-a-uuid",
      userId: "00000000-0000-4000-8000-000000000002",
    });
    expect(r1).toBe(false);

    const r2 = await invitationAddressMatches(sql, {
      invitationId: "00000000-0000-4000-8000-000000000001",
      userId: "not-a-uuid",
    });
    expect(r2).toBe(false);

    expect(queryFn).not.toHaveBeenCalled();
  });

  it("source scan of invitation-email.ts finds no app. reference (pin 17 (no app table))", () => {
    const sourcePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "invitation-email.ts",
    );
    const content = readFileSync(sourcePath, "utf8");
    expect(content).not.toMatch(/app\./i);
  });
});
