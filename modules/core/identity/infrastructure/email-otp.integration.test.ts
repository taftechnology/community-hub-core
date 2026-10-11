import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blindIndex, decrypt, deriveKeys, unwrapKmsRoot } from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "@community-hub/db/plaintext";
import { beforeAll, describe, expect, it } from "vitest";

import { OtpMailUnavailable, type OtpMail } from "../domain/otp-mail.js";
import { startEmailOtp, verifyEmailOtp } from "../public/index.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const CONTEXT = { key_kind: "identity", region: "au", key_version: "1" } as const;

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

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

class MemoryMail implements OtpMail {
  last: { to: string; code: string } | undefined;
  sends = 0;

  send(input: { to: string; code: string }): Promise<void> {
    this.sends += 1;
    this.last = input;
    return Promise.resolve();
  }
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

describe("email one-time code", () => {
  async function clearIdentity(sql: ReturnType<typeof createPlaintextIdentitySql>): Promise<void> {
    await sql`delete from identity.sessions`;
    await sql`delete from identity.passkey_credentials`;
    await sql`delete from identity.passkey_challenges`;
    await sql`delete from identity.otp_challenges`;
    await sql`delete from identity.users`;
    await sql`delete from identity.identity_keys`;
  }

  async function withSql<T>(
    run: (sql: ReturnType<typeof createPlaintextIdentitySql>) => Promise<T>,
  ) {
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      await clearIdentity(sql);
      return await run(sql);
    } finally {
      await clearIdentity(sql);
      await sql.end({ timeout: 1 });
    }
  }

  it("sends an eight-digit code and verifies it once", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "Ada@Example.com", now });
      expect(mail.last).toEqual({ to: "ada@example.com", code: expect.stringMatching(/^\d{8}$/) });
      const open = await sql<{ code_hash: Uint8Array }[]>`
        select code_hash from identity.otp_challenges where consumed_at is null
      `;
      expect(open).toHaveLength(1);
      expect(open[0]?.code_hash).toHaveLength(32);
      expect(Buffer.from(open[0]?.code_hash ?? []).equals(Buffer.from(mail.last?.code ?? ""))).toBe(
        false,
      );

      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now });
      const rows = await sql<{ consumed_at: Date | null; code_hash: Uint8Array }[]>`
        select consumed_at, code_hash from identity.otp_challenges order by consumed_at nulls last
      `;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.consumed_at).not.toBeNull();
      expect(rows[1]?.consumed_at).toBeNull();

      const verified = await verifyEmailOtp(sql, kms, KEY_ARN, {
        email: "ada@example.com",
        code: mail.last?.code ?? "",
        now,
      });
      expect(verified).toMatchObject({ userId: expect.any(String), expiresIn: 900 });
      expect(verified?.accessToken.includes("=")).toBe(false);
      expect(verified?.refreshToken.includes("=")).toBe(false);
      const session = await sql<{ access_hash: Uint8Array; refresh_hash: Uint8Array }[]>`
        select access_hash, refresh_hash from identity.sessions
      `;
      expect(session).toHaveLength(1);
      const accessHash = Buffer.from(session[0]?.access_hash ?? []);
      const refreshHash = Buffer.from(session[0]?.refresh_hash ?? []);
      expect(accessHash.equals(Buffer.from(verified?.accessToken ?? "", "base64url"))).toBe(false);
      expect(refreshHash.equals(Buffer.from(verified?.refreshToken ?? "", "base64url"))).toBe(
        false,
      );
      const again = await verifyEmailOtp(sql, kms, KEY_ARN, {
        email: "ada@example.com",
        code: mail.last?.code ?? "",
        now,
      });
      expect(again).toBeNull();

      const stored = await sql<{ id: string; wrapped: Uint8Array }[]>`
        select id, wrapped from identity.identity_keys where region = 'au'
      `;
      const key = stored[0];
      expect(key).toBeDefined();
      const hkdfKey = await unwrapKmsRoot(kms, KEY_ARN, key?.wrapped ?? new Uint8Array(), CONTEXT);
      const { enc, bidx } = await deriveKeys(hkdfKey);
      const emailBidx = await blindIndex(
        bidx,
        "identity.users.email",
        new TextEncoder().encode("ada@example.com"),
      );
      const users = await sql<{ id: string; email: Uint8Array }[]>`
        select id, email from identity.users where email_bidx = ${emailBidx}
      `;
      expect(users).toHaveLength(1);
      expect(users[0]?.id).toBe(verified?.userId);
      const plaintext = await decrypt(users[0]?.email as never, () => enc, {
        tag: "chub/field-identity/v1",
        label: "identity.users.email",
        rowId: uuidToBytes(verified?.userId ?? ""),
        region: "au",
      });
      expect(new TextDecoder().decode(plaintext)).toBe("ada@example.com");
    });
  });

  it("consumes the challenge on the fifth mismatch and rejects an expired or unknown code", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now });
      const code = mail.last?.code ?? "";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const wrong = await verifyEmailOtp(sql, kms, KEY_ARN, {
          email: "ada@example.com",
          code: "00000000",
          now,
        });
        expect(wrong).toBeNull();
      }
      const consumed = await sql<{ consumed_at: Date | null; attempts: number }[]>`
        select consumed_at, attempts from identity.otp_challenges
      `;
      expect(consumed[0]?.attempts).toBe(5);
      expect(consumed[0]?.consumed_at).not.toBeNull();
      expect(
        await verifyEmailOtp(sql, kms, KEY_ARN, { email: "ada@example.com", code, now }),
      ).toBeNull();

      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now });
      const later = new Date(now.getTime() + 10 * 60 * 1000 + 1);
      expect(
        await verifyEmailOtp(sql, kms, KEY_ARN, {
          email: "ada@example.com",
          code: mail.last?.code ?? "",
          now: later,
        }),
      ).toBeNull();
      expect(
        await verifyEmailOtp(sql, kms, KEY_ARN, {
          email: "missing@example.com",
          code: "12345678",
          now,
        }),
      ).toBeNull();
    });
  });

  it("rejects an invalid address before mail and deletes a challenge the mail port refuses", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await expect(
        startEmailOtp(sql, kms, KEY_ARN, mail, { email: "", now }),
      ).rejects.toMatchObject({ code: "invalid_email" });
      expect(mail.sends).toBe(0);
      const before = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.otp_challenges
      `;
      const rejecting: OtpMail = {
        send() {
          return Promise.reject(new OtpMailUnavailable());
        },
      };
      await expect(
        startEmailOtp(sql, kms, KEY_ARN, rejecting, { email: "ada@example.com", now }),
      ).rejects.toBeInstanceOf(OtpMailUnavailable);
      const after = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.otp_challenges
      `;
      expect(after).toEqual(before);
    });
  });
});
