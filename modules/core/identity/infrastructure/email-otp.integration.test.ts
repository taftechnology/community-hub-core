import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { blindIndex, decrypt, deriveKeys, unwrapKmsRoot } from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "@community-hub/db/plaintext";
import { beforeAll, describe, expect, it } from "vitest";

import { OtpMailUnavailable, type OtpMail } from "../domain/otp-mail.js";
import { startEmailOtp, verifyEmailOtp, type OtpPurpose } from "../public/index.js";

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

function challengeStatements(queries: readonly string[]): string[] {
  return queries.filter((query) => query.includes("identity.otp_challenges"));
}

function expectOneUpdateReturning(queries: readonly string[]): void {
  expect(queries).toHaveLength(1);
  const statement = queries[0]?.toLowerCase() ?? "";
  expect(statement.includes("update")).toBe(true);
  expect(statement.includes("returning")).toBe(true);
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

  it("counts forty parallel wrong guesses and then rejects the right code", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    const sql = postgres(identityUrl(loadRuntime()), {
      max: 40,
      prepare: true,
      onnotice: () => undefined,
    });
    try {
      await clearIdentity(sql);
      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now });
      const code = mail.last?.code ?? "";
      const wrong = code === "00000000" ? "11111111" : "00000000";
      const results = await Promise.all(
        Array.from({ length: 40 }, () =>
          verifyEmailOtp(sql, kms, KEY_ARN, { email: "ada@example.com", code: wrong, now }),
        ),
      );
      expect(results.every((result) => result === null)).toBe(true);
      const consumed = await sql<{ consumed_at: Date | null; attempts: number }[]>`
        select consumed_at, attempts from identity.otp_challenges
      `;
      expect(consumed[0]?.attempts).toBe(5);
      expect(consumed[0]?.consumed_at).not.toBeNull();
      expect(
        await verifyEmailOtp(sql, kms, KEY_ARN, { email: "ada@example.com", code, now }),
      ).toBeNull();
    } finally {
      await clearIdentity(sql);
      await sql.end({ timeout: 1 });
    }
  });

  it("updates the challenge in one statement for a wrong code and a right code", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    const queries: string[] = [];
    const sql = postgres(identityUrl(loadRuntime()), {
      max: 1,
      prepare: true,
      onnotice: () => undefined,
      debug(_connection, query) {
        queries.push(query);
      },
    });
    try {
      await clearIdentity(sql);
      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now });
      const code = mail.last?.code ?? "";
      const wrong = code === "00000000" ? "11111111" : "00000000";
      queries.length = 0;
      expect(
        await verifyEmailOtp(sql, kms, KEY_ARN, { email: "ada@example.com", code: wrong, now }),
      ).toBeNull();
      expectOneUpdateReturning(challengeStatements(queries));
      queries.length = 0;
      expect(
        await verifyEmailOtp(sql, kms, KEY_ARN, { email: "ada@example.com", code, now }),
      ).not.toBeNull();
      const userLookup = queries.findIndex((query) => query.includes("identity.users"));
      expect(userLookup).toBeGreaterThanOrEqual(0);
      expectOneUpdateReturning(challengeStatements(queries.slice(0, userLookup)));
    } finally {
      await clearIdentity(sql);
      await sql.end({ timeout: 1 });
    }
  });

  it("returns one session when the right code is verified twice in parallel", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    const runtime = loadRuntime();
    const url = identityUrl(runtime);
    const holder = postgres(url, { max: 1, prepare: true, onnotice: () => undefined });
    const sql = postgres(url, { max: 4, prepare: true, onnotice: () => undefined });
    const observer = createPlaintextDirectSql(runtime.productOnlyUrl);
    let pending: Promise<Awaited<ReturnType<typeof verifyEmailOtp>>[]> = Promise.resolve([]);
    try {
      await clearIdentity(sql);
      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now });
      const code = mail.last?.code ?? "";
      let locked: () => void = () => undefined;
      const lockHeld = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const gate = holder.begin(async (tx) => {
        await tx`select id from identity.otp_challenges for update`;
        locked();
        const started = Date.now();
        while (Date.now() - started < 5_000) {
          const waiting = await observer<{ n: number }[]>`
            select count(*)::int as n
            from pg_stat_activity
            where datname = current_database()
              and state = 'active'
              and wait_event_type = 'Lock'
              and query like '%update identity.otp_challenges%'
          `;
          if ((waiting[0]?.n ?? 0) >= 2) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        throw new Error("verifications did not wait on the challenge");
      });
      await lockHeld;
      pending = Promise.all([
        verifyEmailOtp(sql, kms, KEY_ARN, { email: "ada@example.com", code, now }),
        verifyEmailOtp(sql, kms, KEY_ARN, { email: "ada@example.com", code, now }),
      ]);
      await gate;
      const results = await pending;
      expect(results.filter((result) => result !== null)).toHaveLength(1);
    } finally {
      await pending.catch(() => undefined);
      await clearIdentity(sql);
      await sql.end({ timeout: 1 });
      await holder.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
    }
  }, 15_000);

  it("sends at most five mails when sixty starts race one address", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    const sql = postgres(identityUrl(loadRuntime()), {
      max: 60,
      prepare: true,
      onnotice: () => undefined,
    });
    try {
      await clearIdentity(sql);
      await Promise.all(
        Array.from({ length: 60 }, () =>
          startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now }),
        ),
      );
      expect(mail.sends).toBeLessThanOrEqual(5);
      const open = await sql<{ n: number }[]>`
        select count(*)::int as n
        from identity.otp_challenges
        where consumed_at is null
      `;
      expect(Number(open[0]?.n)).toBeLessThanOrEqual(1);
    } finally {
      await clearIdentity(sql);
      await sql.end({ timeout: 1 });
    }
  }, 30_000);

  it("creates at most five codes for an address in sixty minutes", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      for (let sent = 0; sent < 5; sent += 1) {
        await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now });
      }
      expect(mail.sends).toBe(5);
      const before = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.otp_challenges
      `;
      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now });
      expect(mail.sends).toBe(5);
      const after = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.otp_challenges
      `;
      expect(after).toEqual(before);

      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "other@example.com", now });
      expect(mail.sends).toBe(6);

      const later = new Date(now.getTime() + 60 * 60 * 1000);
      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now: later });
      expect(mail.sends).toBe(7);
    });
  });

  it("leaves the caller's timestamp parsers unchanged", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await sql`select now(), ${"example"}::text, ${"00000000-0000-0000-0000-000000000000"}::uuid`;
      const parsers = { ...sql.options.parsers };
      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now });
      await verifyEmailOtp(sql, kms, KEY_ARN, {
        email: "ada@example.com",
        code: mail.last?.code ?? "",
        now,
      });
      expect({ ...sql.options.parsers }).toEqual(parsers);
    });
  });

  it("defaults purpose to sign_in when omitted", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now });
      const rows = await sql<{ purpose: string }[]>`
        select purpose from identity.otp_challenges
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.purpose).toBe("sign_in");
    });
  });

  it("a sign-in start leaves an enrolment challenge open", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    const enrolmentPurpose: OtpPurpose = "operator_enrolment";
    const signInPurpose: OtpPurpose = "sign_in";
    await withSql(async (sql) => {
      // 1. Start an operator_enrolment challenge
      await startEmailOtp(sql, kms, KEY_ARN, mail, {
        email: "ada@example.com",
        now,
        purpose: enrolmentPurpose,
      });
      expect(mail.last?.code).toMatch(/^\d{8}$/);

      const enrolmentRows = await sql<{ id: string; purpose: string; consumed_at: Date | null }[]>`
        select id, purpose, consumed_at from identity.otp_challenges where purpose = 'operator_enrolment'
      `;
      expect(enrolmentRows).toHaveLength(1);
      expect(enrolmentRows[0]?.consumed_at).toBeNull();
      expect(enrolmentRows[0]?.purpose).toBe("operator_enrolment");

      // 2. Start a sign_in challenge for the same address
      await startEmailOtp(sql, kms, KEY_ARN, mail, {
        email: "ada@example.com",
        now,
        purpose: signInPurpose,
      });
      expect(mail.last?.code).toMatch(/^\d{8}$/);

      // The enrolment challenge must still be open
      const afterSignInStart = await sql<
        { id: string; purpose: string; consumed_at: Date | null }[]
      >`
        select id, purpose, consumed_at from identity.otp_challenges order by purpose
      `;
      expect(afterSignInStart).toHaveLength(2);
      const enrolmentAfter = afterSignInStart.find((r) => r.purpose === "operator_enrolment");
      const signInAfter = afterSignInStart.find((r) => r.purpose === "sign_in");
      expect(enrolmentAfter?.consumed_at).toBeNull();
      expect(signInAfter?.consumed_at).toBeNull();

      // 3. Second way: start another operator_enrolment challenge
      // It supersedes the old operator_enrolment challenge, but leaves the sign_in challenge open
      await startEmailOtp(sql, kms, KEY_ARN, mail, {
        email: "ada@example.com",
        now,
        purpose: "operator_enrolment",
      });
      const openAfterSecondEnrolment = await sql<{ purpose: string; consumed_at: Date | null }[]>`
        select purpose, consumed_at from identity.otp_challenges where consumed_at is null
      `;
      expect(openAfterSecondEnrolment).toHaveLength(2);
      expect(openAfterSecondEnrolment.map((r) => r.purpose).sort()).toEqual([
        "operator_enrolment",
        "sign_in",
      ]);

      // 4. Start another sign_in challenge
      // It supersedes the old sign_in challenge, but leaves the operator_enrolment challenge open
      await startEmailOtp(sql, kms, KEY_ARN, mail, {
        email: "ada@example.com",
        now,
        purpose: "sign_in",
      });
      const openAfterSecondSignIn = await sql<{ purpose: string; consumed_at: Date | null }[]>`
        select purpose, consumed_at from identity.otp_challenges where consumed_at is null
      `;
      expect(openAfterSecondSignIn).toHaveLength(2);
      expect(openAfterSecondSignIn.map((r) => r.purpose).sort()).toEqual([
        "operator_enrolment",
        "sign_in",
      ]);
    });
  });

  it("five enrolment starts do not use the sign-in cap", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      // 5 enrolment starts
      for (let i = 0; i < 5; i += 1) {
        await startEmailOtp(sql, kms, KEY_ARN, mail, {
          email: "ada@example.com",
          now,
          purpose: "operator_enrolment",
        });
      }
      expect(mail.sends).toBe(5);

      // A 6th enrolment start hits the cap for operator_enrolment
      await startEmailOtp(sql, kms, KEY_ARN, mail, {
        email: "ada@example.com",
        now,
        purpose: "operator_enrolment",
      });
      expect(mail.sends).toBe(5);

      // But a sign_in start for the same address does not use the enrolment cap
      await startEmailOtp(sql, kms, KEY_ARN, mail, {
        email: "ada@example.com",
        now,
        purpose: "sign_in",
      });
      expect(mail.sends).toBe(6);

      // And sign_in can be verified
      const verified = await verifyEmailOtp(sql, kms, KEY_ARN, {
        email: "ada@example.com",
        code: mail.last?.code ?? "",
        now,
      });
      expect(verified).not.toBeNull();
    });
  });

  it("sign-in verify ignores enrolment challenges", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      await startEmailOtp(sql, kms, KEY_ARN, mail, {
        email: "ada@example.com",
        now,
        purpose: "operator_enrolment",
      });
      const enrolmentCode = mail.last?.code ?? "";
      expect(enrolmentCode).toMatch(/^\d{8}$/);

      // verifyEmailOtp is only for sign_in, so it must ignore the operator_enrolment challenge
      const verified = await verifyEmailOtp(sql, kms, KEY_ARN, {
        email: "ada@example.com",
        code: enrolmentCode,
        now,
      });
      expect(verified).toBeNull();

      // The enrolment challenge is untouched
      const rows = await sql<{ consumed_at: Date | null; attempts: number }[]>`
        select consumed_at, attempts
        from identity.otp_challenges
        where purpose = 'operator_enrolment'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.consumed_at).toBeNull();
      expect(rows[0]?.attempts).toBe(0);
    });
  });
});
