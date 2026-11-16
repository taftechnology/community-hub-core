import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "@community-hub/db/plaintext";
import type { Sql } from "postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { deriveIdentityEmailKeys, insertIdentityUserWithKeys } from "./email-lookup.js";
import { ensureIdentityKey } from "./identity-key.js";
import {
  closeInvitationEmail,
  createInvitationEmail,
  invitationAddressMatches,
  openInvitationEmails,
  refreshInvitationEmail,
  sweepInvitationEmails,
} from "./invitation-email.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;

type Runtime = {
  productOnlyUrl: string;
  passwords: { identity: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function identityUrl(runtime: Runtime): string {
  const password = encodeURIComponent(runtime.passwords.identity);
  return `postgres://identity:${password}@127.0.0.1:5432/hub_product_only`;
}

beforeAll(async () => {
  const runtime = loadRuntime();
  const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

async function clearIdentity(sql: ReturnType<typeof createPlaintextIdentitySql>): Promise<void> {
  await sql`delete from identity.invitation_emails`;
  await sql`delete from identity.sessions`;
  await sql`delete from identity.passkey_credentials`;
  await sql`delete from identity.passkey_challenges`;
  await sql`delete from identity.otp_challenges`;
  await sql`delete from identity.users`;
  await sql`delete from identity.identity_keys`;
}

async function withSql<T>(
  run: (sql: ReturnType<typeof createPlaintextIdentitySql>) => Promise<T>,
): Promise<T> {
  const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
  try {
    await clearIdentity(sql);
    return await run(sql);
  } finally {
    await clearIdentity(sql);
    await sql.end({ timeout: 1 });
  }
}

describe("invitation-email integration tests", () => {
  it("pin 15: two invitations opened in reverse order return their own address; copied ciphertext fails to open", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const communityId = newId();
      const id1 = newId();
      const id2 = newId();
      const future = new Date(Date.now() + 3600_000);

      const r1 = await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: id1,
        communityId,
        address: "ada@example.test",
        expiresAt: future,
      });
      expect(r1).toEqual({ ok: true });

      const r2 = await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: id2,
        communityId,
        address: "grace@example.test",
        expiresAt: future,
      });
      expect(r2).toEqual({ ok: true });

      // Reverse id order
      const opened = await openInvitationEmails(sql, kms, KEY_ARN, [id2, id1]);
      expect(opened.get(id1)).toBe("ada@example.test");
      expect(opened.get(id2)).toBe("grace@example.test");

      // Copy id1's ciphertext into id2's row
      const [row1] = await sql<{ email: Uint8Array }[]>`
        select email from identity.invitation_emails where invitation_id = ${id1}::uuid
      `;
      expect(row1?.email).toBeDefined();

      await sql`
        update identity.invitation_emails
        set email = ${row1!.email}
        where invitation_id = ${id2}::uuid
      `;

      await expect(openInvitationEmails(sql, kms, KEY_ARN, [id2])).rejects.toThrow();
    });
  });

  it("pin 16: invitation created with padded mixed-case address matches user created with normalised address", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const keys = await deriveIdentityEmailKeys(sql, kms, KEY_ARN);
      const user1 = await insertIdentityUserWithKeys(sql, keys, "alex@example.test");
      const user2 = await insertIdentityUserWithKeys(sql, keys, "other@example.test");

      const invitationId = newId();
      const communityId = newId();
      const future = new Date(Date.now() + 3600_000);

      await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId,
        communityId,
        address: " Alex@Example.Test ",
        expiresAt: future,
      });

      const matchesUser1 = await invitationAddressMatches(sql, {
        invitationId,
        userId: user1.userId,
      });
      expect(matchesUser1).toBe(true);

      const matchesUser2 = await invitationAddressMatches(sql, {
        invitationId,
        userId: user2.userId,
      });
      expect(matchesUser2).toBe(false);
    });
  });

  it("pin 17b: openInvitationEmails does not return expired or closed rows", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const communityId = newId();
      const future = new Date(Date.now() + 3600_000);
      const past = new Date(Date.now() - 3600_000);

      const idActive = newId();
      const idExpired = newId();
      const idClosed = newId();

      await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: idActive,
        communityId,
        address: "active@example.test",
        expiresAt: future,
      });

      await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: idExpired,
        communityId,
        address: "expired@example.test",
        expiresAt: past,
      });

      await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: idClosed,
        communityId,
        address: "closed@example.test",
        expiresAt: future,
      });
      await closeInvitationEmail(sql, idClosed);

      const result = await openInvitationEmails(sql, kms, KEY_ARN, [idActive, idExpired, idClosed]);
      expect(result.get(idActive)).toBe("active@example.test");
      expect(result.has(idExpired)).toBe(false);
      expect(result.has(idClosed)).toBe(false);
      expect(result.size).toBe(1);
    });
  });

  it("pin 18: throws identity key is missing when identity_keys row is missing and creates no key row", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const communityId = newId();
      const invitationId = newId();
      const future = new Date(Date.now() + 3600_000);

      await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId,
        communityId,
        address: "ada@example.test",
        expiresAt: future,
      });

      // Delete only the key row
      await sql`delete from identity.identity_keys`;

      await expect(
        createInvitationEmail(sql, kms, KEY_ARN, {
          invitationId: newId(),
          communityId,
          address: "grace@example.test",
          expiresAt: future,
        }),
      ).rejects.toThrow("identity key is missing");

      await expect(openInvitationEmails(sql, kms, KEY_ARN, [invitationId])).rejects.toThrow(
        "identity key is missing",
      );

      const keys = await sql<{ count: number }[]>`
        select count(*)::int as count from identity.identity_keys
      `;
      expect(keys[0]?.count).toBe(0);
    });
  });

  it("pin 21 (identity half) & A5 test f: community scoping, deduplication and reuse after close/expiry", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const commA = newId();
      const commB = newId();
      const idA1 = newId();
      const idB1 = newId();
      const idA2 = newId();
      const idA3 = newId();
      const future = new Date(Date.now() + 3600_000);

      // Same address in two different community ids gives two ok rows
      const rA1 = await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: idA1,
        communityId: commA,
        address: "alex@example.test",
        expiresAt: future,
      });
      expect(rA1).toEqual({ ok: true });

      const rB1 = await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: idB1,
        communityId: commB,
        address: "alex@example.test",
        expiresAt: future,
      });
      expect(rB1).toEqual({ ok: true });

      // Second pending create in the same community gives already_invited
      const rA2 = await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: idA2,
        communityId: commA,
        address: "alex@example.test",
        expiresAt: future,
      });
      expect(rA2).toEqual({ ok: false, reason: "already_invited" });

      // After closing idA1, a new create in community A succeeds
      await closeInvitationEmail(sql, idA1);
      const rA3 = await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: idA3,
        communityId: commA,
        address: "alex@example.test",
        expiresAt: future,
      });
      expect(rA3).toEqual({ ok: true });

      // After expiring idA3, a new create in community A succeeds and erases old row
      await sql`
        update identity.invitation_emails
        set expires_at = now() - interval '1 hour'
        where invitation_id = ${idA3}::uuid
      `;
      const idA4 = newId();
      const rA4 = await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: idA4,
        communityId: commA,
        address: "alex@example.test",
        expiresAt: future,
      });
      expect(rA4).toEqual({ ok: true });

      // The expired row's payload was erased
      const [oldRow] = await sql<{ email: Uint8Array | null; dedupe_key: Uint8Array | null }[]>`
        select email, dedupe_key from identity.invitation_emails where invitation_id = ${idA3}::uuid
      `;
      expect(oldRow?.email).toBeNull();
      expect(oldRow?.dedupe_key).toBeNull();
    });
  });

  it("pin 23 (identity half) & A5 test e: closeInvitationEmail nulls payload and sets closed_at", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const invitationId = newId();
      const communityId = newId();
      const future = new Date(Date.now() + 3600_000);

      await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId,
        communityId,
        address: "alex@example.test",
        expiresAt: future,
      });

      await closeInvitationEmail(sql, invitationId);

      const [row] = await sql<
        {
          email: Uint8Array | null;
          email_bidx: Uint8Array | null;
          dedupe_key: Uint8Array | null;
          closed_at: Date | null;
        }[]
      >`
        select email, email_bidx, dedupe_key, closed_at
        from identity.invitation_emails
        where invitation_id = ${invitationId}::uuid
      `;

      expect(row?.email).toBeNull();
      expect(row?.email_bidx).toBeNull();
      expect(row?.dedupe_key).toBeNull();
      expect(row?.closed_at).toBeInstanceOf(Date);
    });
  });

  it("A5 test b: with no sweep run, expired row returns nothing in openInvitationEmails and false in invitationAddressMatches", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const keys = await deriveIdentityEmailKeys(sql, kms, KEY_ARN);
      const user = await insertIdentityUserWithKeys(sql, keys, "alex@example.test");

      const invitationId = newId();
      const communityId = newId();
      const past = new Date(Date.now() - 60_000);

      await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId,
        communityId,
        address: "alex@example.test",
        expiresAt: past,
      });

      // No sweep run
      const opened = await openInvitationEmails(sql, kms, KEY_ARN, [invitationId]);
      expect(opened.has(invitationId)).toBe(false);

      const matches = await invitationAddressMatches(sql, {
        invitationId,
        userId: user.userId,
      });
      expect(matches).toBe(false);
    });
  });

  it("A5 test a (identity half): sweep erases expired address across different community ids", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const comm1 = newId();
      const comm2 = newId();
      const id1 = newId();
      const id2 = newId();
      const now = new Date();
      const past1 = new Date(now.getTime() - 5 * 60_000);
      const past2 = new Date(now.getTime() - 10 * 60_000);

      await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: id1,
        communityId: comm1,
        address: "user1@example.test",
        expiresAt: past1,
      });

      await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: id2,
        communityId: comm2,
        address: "user2@example.test",
        expiresAt: past2,
      });

      const sweepResult = await sweepInvitationEmails(sql, now);
      expect(sweepResult.erased).toBe(2);

      const rows = await sql<
        {
          invitation_id: string;
          email: Uint8Array | null;
          email_bidx: Uint8Array | null;
          dedupe_key: Uint8Array | null;
        }[]
      >`
        select invitation_id, email, email_bidx, dedupe_key
        from identity.invitation_emails
        where invitation_id in (${id1}::uuid, ${id2}::uuid)
      `;

      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(row.email).toBeNull();
        expect(row.email_bidx).toBeNull();
        expect(row.dedupe_key).toBeNull();
      }
    });
  });

  it("A5 test c: sweep deletes rows closed or expired > 30 days ago, keeps rows at 29 days", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const now = new Date();
      const dayMs = 24 * 3600_000;

      const idClosed31 = newId();
      const idClosed29 = newId();
      const idExpired31 = newId();

      // Row 1: closed 31 days ago
      await sql`
        insert into identity.invitation_emails (
          invitation_id, region, email, email_bidx, dedupe_key, expires_at, closed_at, created_at
        ) values (
          ${idClosed31}::uuid, 'au', null, null, null,
          ${new Date(now.getTime() - 35 * dayMs)},
          ${new Date(now.getTime() - 31 * dayMs)},
          ${new Date(now.getTime() - 40 * dayMs)}
        )
      `;

      // Row 2: closed 29 days ago
      await sql`
        insert into identity.invitation_emails (
          invitation_id, region, email, email_bidx, dedupe_key, expires_at, closed_at, created_at
        ) values (
          ${idClosed29}::uuid, 'au', null, null, null,
          ${new Date(now.getTime() - 35 * dayMs)},
          ${new Date(now.getTime() - 29 * dayMs)},
          ${new Date(now.getTime() - 40 * dayMs)}
        )
      `;

      // Row 3: expired 31 days ago, never closed
      await sql`
        insert into identity.invitation_emails (
          invitation_id, region, email, email_bidx, dedupe_key, expires_at, closed_at, created_at
        ) values (
          ${idExpired31}::uuid, 'au', null, null, null,
          ${new Date(now.getTime() - 31 * dayMs)},
          null,
          ${new Date(now.getTime() - 40 * dayMs)}
        )
      `;

      const result = await sweepInvitationEmails(sql, now);
      expect(result.deleted).toBe(2);

      const surviving = await sql<{ invitation_id: string }[]>`
        select invitation_id from identity.invitation_emails
        where invitation_id in (${idClosed31}::uuid, ${idClosed29}::uuid, ${idExpired31}::uuid)
      `;

      expect(surviving.map((r) => r.invitation_id)).toEqual([idClosed29]);
    });
  });

  it("M1 pin: sweep deletes rather than erases row expired > 30 days ago with unswept address", async () => {
    await withSql(async (sql) => {
      const now = new Date();
      const dayMs = 24 * 3600_000;
      const id = newId();
      const dummyByte = new Uint8Array(32);
      dummyByte.fill(1);

      // Seed one row that is never closed, still holds an address, and expired 31 days before now
      await sql`
        insert into identity.invitation_emails (
          invitation_id, region, email, email_bidx, dedupe_key, expires_at, closed_at, created_at
        ) values (
          ${id}::uuid, 'au', ${dummyByte}, ${dummyByte}, ${dummyByte},
          ${new Date(now.getTime() - 31 * dayMs)},
          null,
          ${new Date(now.getTime() - 40 * dayMs)}
        )
      `;

      const result = await sweepInvitationEmails(sql, now);
      expect(result).toEqual({ erased: 0, deleted: 1 });

      const remaining = await sql<{ count: number }[]>`
        select count(*)::int as count from identity.invitation_emails
      `;
      expect(remaining[0]?.count).toBe(0);
    });
  });

  it("pin 56: seed 501 rows expired 31 to 40 days ago, sweep returns erased 1 deleted 500, remaining has nulls", async () => {
    await withSql(async (sql) => {
      const now = new Date();
      const dayMs = 24 * 3600_000;
      const dummyByte = new Uint8Array(32);
      dummyByte.fill(1);

      const rows = Array.from({ length: 501 }, (_, i) => {
        const id = `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`;
        const dedupe = new Uint8Array(32);
        new DataView(dedupe.buffer).setUint32(0, i);
        const expiredDaysAgo = 31 + (i % 10);
        return {
          invitation_id: id,
          region: "au",
          email: dummyByte,
          email_bidx: dummyByte,
          dedupe_key: dedupe,
          expires_at: new Date(now.getTime() - expiredDaysAgo * dayMs),
          created_at: new Date(now.getTime() - 50 * dayMs),
        };
      });

      await sql`
        insert into identity.invitation_emails ${sql(
          rows,
          "invitation_id",
          "region",
          "email",
          "email_bidx",
          "dedupe_key",
          "expires_at",
          "created_at",
        )}
      `;

      const result = await sweepInvitationEmails(sql, now);
      expect(result).toEqual({ erased: 1, deleted: 500 });

      const remaining = await sql<
        {
          invitation_id: string;
          email: Uint8Array | null;
          email_bidx: Uint8Array | null;
          dedupe_key: Uint8Array | null;
        }[]
      >`
        select invitation_id, email, email_bidx, dedupe_key
        from identity.invitation_emails
      `;

      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.email).toBeNull();
      expect(remaining[0]!.email_bidx).toBeNull();
      expect(remaining[0]!.dedupe_key).toBeNull();
    });
  }, 20_000);

  it("A5 test d: seeding 501 erasable rows, first sweep erases 500, second erases 1", async () => {
    await withSql(async (sql) => {
      const now = new Date();
      const dayMs = 24 * 3600_000;

      const dummyByte = new Uint8Array(32);
      dummyByte.fill(1);

      const rows = Array.from({ length: 501 }, (_, i) => {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
        const dedupe = new Uint8Array(32);
        new DataView(dedupe.buffer).setUint32(0, i);
        return {
          invitation_id: id,
          region: "au",
          email: dummyByte,
          email_bidx: dummyByte,
          dedupe_key: dedupe,
          expires_at: new Date(now.getTime() - 1000),
          created_at: new Date(now.getTime() - 10 * dayMs),
        };
      });

      await sql`
          insert into identity.invitation_emails ${sql(
            rows,
            "invitation_id",
            "region",
            "email",
            "email_bidx",
            "dedupe_key",
            "expires_at",
            "created_at",
          )}
        `;

      const sweep1 = await sweepInvitationEmails(sql, now);
      expect(sweep1.erased).toBe(500);

      const sweep2 = await sweepInvitationEmails(sql, now);
      expect(sweep2.erased).toBe(1);
    });
  }, 20_000);

  it("sweepInvitationEmails issues exactly one SQL statement", async () => {
    await withSql(async (sql) => {
      let statementCount = 0;
      const statementSpy = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        statementCount += 1;
        return (sql as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => unknown)(
          strings,
          ...values,
        );
      }) as unknown as Sql;

      await sweepInvitationEmails(statementSpy, new Date());
      expect(statementCount).toBe(1);
    });
  });

  it("refreshInvitationEmail updates expires_at for open row and returns true, returns false otherwise", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const communityId = newId();
      const idActive = newId();
      const idClosed = newId();
      const initialExpiry = new Date(Date.now() + 3600_000);
      const newExpiry = new Date(Date.now() + 7200_000);

      await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: idActive,
        communityId,
        address: "refresh@example.test",
        expiresAt: initialExpiry,
      });

      await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: idClosed,
        communityId,
        address: "closed@example.test",
        expiresAt: initialExpiry,
      });
      await closeInvitationEmail(sql, idClosed);

      const okActive = await refreshInvitationEmail(sql, {
        invitationId: idActive,
        expiresAt: newExpiry,
      });
      expect(okActive).toBe(true);

      const [rowActive] = await sql<{ expires_at: Date }[]>`
        select expires_at from identity.invitation_emails where invitation_id = ${idActive}::uuid
      `;
      expect(rowActive?.expires_at.getTime()).toBe(newExpiry.getTime());

      // Closed row returns false
      const okClosed = await refreshInvitationEmail(sql, {
        invitationId: idClosed,
        expiresAt: newExpiry,
      });
      expect(okClosed).toBe(false);

      // Non-existent id returns false
      const okMissing = await refreshInvitationEmail(sql, {
        invitationId: newId(),
        expiresAt: newExpiry,
      });
      expect(okMissing).toBe(false);
    });
  });

  it("L1 pin: refreshInvitationEmail returns false and leaves expires_at unchanged for expired unswept row", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const communityId = newId();
      const idExpired = newId();
      const pastExpiry = new Date(Date.now() - 3600_000);
      const newExpiry = new Date(Date.now() + 7200_000);

      await createInvitationEmail(sql, kms, KEY_ARN, {
        invitationId: idExpired,
        communityId,
        address: "expired@example.test",
        expiresAt: pastExpiry,
      });

      // No sweep has run, so the expired row still holds an address
      const refreshed = await refreshInvitationEmail(sql, {
        invitationId: idExpired,
        expiresAt: newExpiry,
      });
      expect(refreshed).toBe(false);

      const [row] = await sql<{ expires_at: Date }[]>`
        select expires_at from identity.invitation_emails where invitation_id = ${idExpired}::uuid
      `;
      expect(row?.expires_at.getTime()).toBe(pastExpiry.getTime());
    });
  });
});
