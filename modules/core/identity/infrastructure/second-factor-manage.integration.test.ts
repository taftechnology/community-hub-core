import { createHash, generateKeyPairSync, sign as signDer } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { type KmsPort } from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "@community-hub/db/plaintext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encodeCbor, type Cbor } from "../domain/cbor.js";
import type { OtpMail } from "../domain/otp-mail.js";
import {
  rejectingSecondFactorNotice,
  type SecondFactorNotice,
  type SecondFactorNoticeKind,
} from "../domain/second-factor-notice.js";
import { base32Decode, stepAt, totpCode } from "../domain/totp.js";
import {
  beginTenantPasskeyRegistration,
  confirmTotpSetup,
  finishTenantPasskeyRegistration,
  freshCheckTotp,
  listSecondFactors,
  readSession,
  readSessionWithKind,
  refreshSession,
  regenerateBackupCodes,
  removePasskey,
  removeTotp,
  startEmailOtp,
  startTotpSetup,
  verifyEmailOtp,
  verifySecondStep,
  type SecondFactorNoticeLogFields,
} from "../public/index.js";
import { insertIdentityUser } from "./identity-user.js";
import { lockSecondFactor } from "./second-factor-lock.js";
import { createSession, sessionAccessHash, type SessionTokens } from "./session.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const ADMIN_RP_ID = "admin.example.test";
const ADMIN_ORIGIN = "https://admin.example.test";
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

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

class MemoryOtpMail implements OtpMail {
  last: { to: string; code: string } | undefined;

  send(input: { to: string; code: string }): Promise<void> {
    this.last = input;
    return Promise.resolve();
  }
}

class MemoryNotice implements SecondFactorNotice {
  calls: { to: string; kind: SecondFactorNoticeKind }[] = [];

  send(input: { to: string; kind: SecondFactorNoticeKind }): Promise<void> {
    this.calls.push(input);
    return Promise.resolve();
  }
}

async function enrolTotpForManageTest(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: {
    email: string;
    now: Date;
    adminRpId: string | null;
    notice?: SecondFactorNotice | undefined;
  },
): Promise<{ tokens: SessionTokens; key: Uint8Array; backupCodes: string[] }> {
  const mail = new MemoryOtpMail();
  await startEmailOtp(sql, kms, keyArn, mail, { email: input.email, now: input.now });
  const emailCode = mail.last?.code ?? "";
  const verified = await verifyEmailOtp(sql, kms, keyArn, {
    email: input.email,
    code: emailCode,
    now: input.now,
  });
  if (verified === null) {
    throw new Error("email verification failed in enrolTotpForManageTest");
  }
  const pre2fa = await createSession(sql, kms, keyArn, {
    userId: verified.userId,
    now: input.now,
    kind: "second_factor",
  });
  const started = await startTotpSetup(sql, kms, keyArn, {
    accessToken: pre2fa.accessToken,
    now: input.now,
    adminRpId: input.adminRpId,
  });
  if (started.outcome !== "started") {
    throw new Error("startTotpSetup failed in enrolTotpForManageTest");
  }
  const key = base32Decode(started.secret);
  if (key === null) {
    throw new Error("invalid base32 secret in enrolTotpForManageTest");
  }
  const confirmed = await confirmTotpSetup(
    sql,
    kms,
    keyArn,
    {
      accessToken: pre2fa.accessToken,
      now: input.now,
      code: totpCode(key, stepAt(input.now)),
      adminRpId: input.adminRpId,
    },
    { notice: input.notice ?? new MemoryNotice() },
  );
  if (confirmed.outcome !== "confirmed" || !confirmed.tokens || !confirmed.backupCodes) {
    throw new Error("confirmTotpSetup failed in enrolTotpForManageTest");
  }
  return { tokens: confirmed.tokens, key, backupCodes: confirmed.backupCodes };
}

async function clearIdentity(direct: Sql, sql: Sql): Promise<void> {
  await direct`delete from identity.second_factor_events`;
  await sql`delete from identity.backup_codes`;
  await sql`delete from identity.totp_credentials`;
  await sql`delete from identity.sessions`;
  await sql`delete from identity.passkey_credentials`;
  await sql`delete from identity.passkey_challenges`;
  await sql`delete from identity.otp_challenges`;
  await sql`delete from identity.users`;
  await sql`delete from identity.identity_keys`;
}

async function withSql<T>(
  run: (sql: Sql, direct: Sql) => Promise<T>,
  options?: { max?: number },
): Promise<T> {
  const runtime = loadRuntime();
  const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
  const sql =
    options?.max !== undefined
      ? postgres(identityUrl(runtime), {
          max: options.max,
          prepare: true,
          onnotice: () => undefined,
        })
      : createPlaintextIdentitySql(identityUrl(runtime));
  try {
    await clearIdentity(direct, sql);
    return await run(sql, direct);
  } finally {
    await clearIdentity(direct, sql);
    await sql.end({ timeout: 1 });
    await direct.end({ timeout: 1 });
  }
}

async function waitForAdvisoryLockWaiter(
  observer: Sql,
  userId: string,
  holderPid: number,
  isSettled: () => boolean,
): Promise<boolean> {
  const pollStart = Date.now();
  while (Date.now() - pollStart < 5_000) {
    if (isSettled()) {
      return false;
    }
    const waitingRows = await observer<{ pid: number }[]>`
      with lock_key as (
        select hashtextextended('2fa:' || ${userId}::text, 0) as key
      )
      select l.pid
      from pg_locks l, lock_key
      where l.locktype = 'advisory'
        and l.objsubid = 1
        and not l.granted
        and l.classid::bigint = ((lock_key.key >> 32) & 4294967295::bigint)
        and l.objid::bigint = (lock_key.key & 4294967295::bigint)
        and l.pid <> ${holderPid}
    `;
    if (waitingRows.length > 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return false;
}

async function insertCountingPasskey(
  sql: Sql,
  userId: string,
  rpId: string,
  createdAt: Date | null,
): Promise<string> {
  const id = newId();
  await sql`
    insert into identity.passkey_credentials (
      id, user_id, credential_id, cose_key, sign_count, rp_id, user_verified, created_at
    ) values (
      ${id}, ${userId}, ${crypto.getRandomValues(new Uint8Array(32))},
      ${crypto.getRandomValues(new Uint8Array(32))}, 0, ${rpId}, true, ${createdAt}
    )
  `;
  return id;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function clientDataBytes(type: string, challenge: Uint8Array, origin: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type,
      challenge: Buffer.from(challenge).toString("base64url"),
      origin,
    }),
  );
}

function coseKeyBytes(x: Uint8Array, y: Uint8Array): Uint8Array {
  return encodeCbor(
    new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
}

function authenticatorDataBytes(input: {
  rpId: string;
  signCount: number;
  credentialId?: Uint8Array;
  cose?: Uint8Array;
  flags?: number;
}): Uint8Array {
  const rpIdHash = new Uint8Array(createHash("sha256").update(Buffer.from(input.rpId)).digest());
  const attested = input.credentialId !== undefined && input.cose !== undefined;
  const flags = input.flags ?? (attested ? 0x45 : 0x05);
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, input.signCount);
  const parts: Uint8Array[] = [rpIdHash, Uint8Array.of(flags), count];
  if (attested && input.credentialId && input.cose) {
    const length = new Uint8Array(2);
    new DataView(length.buffer).setUint16(0, input.credentialId.byteLength);
    parts.push(new Uint8Array(16), length, input.credentialId, input.cose);
  }
  return concatBytes(parts);
}

function attestationObjectBytes(authData: Uint8Array): Uint8Array {
  return encodeCbor(
    new Map<Cbor, Cbor>([
      ["fmt", "none"],
      ["attStmt", new Map<Cbor, Cbor>()],
      ["authData", authData],
    ]),
  );
}

async function generatePasskeySigner(): Promise<{
  x: Uint8Array;
  y: Uint8Array;
  sign: (data: Uint8Array) => Promise<Uint8Array>;
}> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    x: new Uint8Array(Buffer.from(jwk.x ?? "", "base64url")),
    y: new Uint8Array(Buffer.from(jwk.y ?? "", "base64url")),
    sign: async (data) =>
      new Uint8Array(signDer("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "der" })),
  };
}

async function insertBackupCodeForTest(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  email: string,
  now: Date,
): Promise<{ userId: string; backupCodes: string[] }> {
  const enrolled = await enrolTotpForManageTest(sql, kms, keyArn, {
    email,
    now,
    adminRpId: ADMIN_RP_ID,
  });
  return { userId: enrolled.tokens.userId, backupCodes: enrolled.backupCodes };
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

afterAll(async () => {
  const runtime = loadRuntime();
  const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
  const sql = createPlaintextIdentitySql(identityUrl(runtime));
  try {
    await clearIdentity(direct, sql);
  } finally {
    await sql.end({ timeout: 1 });
    await direct.end({ timeout: 1 });
  }
});

describe("second-factor service: fresh check, recovery window, removal, notices", () => {
  const kms = createLocalKmsPort();

  // Pin 43
  it("refuses factor changes without a fresh check", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin43@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const pkId = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const notice = new MemoryNotice();

      // Admin session with fresh_factor_at = null (e.g. first setup or after refresh)
      const stale = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: null,
      });

      await expect(
        startTotpSetup(sql, kms, KEY_ARN, {
          accessToken: stale.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      await expect(
        regenerateBackupCodes(
          sql,
          kms,
          KEY_ARN,
          { accessToken: stale.accessToken, now },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      await expect(
        removeTotp(
          sql,
          kms,
          KEY_ARN,
          { accessToken: stale.accessToken, now, adminRpId: ADMIN_RP_ID },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      await expect(
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          { accessToken: stale.accessToken, now, adminRpId: ADMIN_RP_ID, passkeyId: pkId },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      expect(notice.calls).toHaveLength(0);

      const listed = await listSecondFactors(sql, kms, KEY_ARN, {
        accessToken: stale.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(listed).toEqual({
        outcome: "listed",
        totp: { confirmedAt: now },
        passkeys: [{ id: pkId, createdAt: now }],
        backupCodesLeft: 10,
        freshUntil: null,
      });
    });
  });

  // Pin 44
  it("refuses factor changes five minutes after the fresh check", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin44@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const pkId = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const notice = new MemoryNotice();

      const freshSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });

      const pastFiveMin = new Date(now.getTime() + FIVE_MINUTES_MS + 1);
      await expect(
        startTotpSetup(sql, kms, KEY_ARN, {
          accessToken: freshSession.accessToken,
          now: pastFiveMin,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      await expect(
        regenerateBackupCodes(
          sql,
          kms,
          KEY_ARN,
          { accessToken: freshSession.accessToken, now: pastFiveMin },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      await expect(
        removeTotp(
          sql,
          kms,
          KEY_ARN,
          { accessToken: freshSession.accessToken, now: pastFiveMin, adminRpId: ADMIN_RP_ID },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      await expect(
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: freshSession.accessToken,
            now: pastFiveMin,
            adminRpId: ADMIN_RP_ID,
            passkeyId: pkId,
          },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      // Exactly at 5 minutes, the fresh window is still valid
      const atFiveMin = new Date(now.getTime() + FIVE_MINUTES_MS);
      const made = await regenerateBackupCodes(
        sql,
        kms,
        KEY_ARN,
        { accessToken: freshSession.accessToken, now: atFiveMin },
        { notice },
      );
      expect(made.outcome).toBe("made");
    });
  });

  // Pin 45
  it("a recovery session cannot pass a fresh check with a factor set up in it", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin45@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const notice = new MemoryNotice();

      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const recovery = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now: t1,
        method: "backup_code",
        code: enrolled.backupCodes[0]!,
      });
      expect(recovery.outcome).toBe("verified");
      if (recovery.outcome !== "verified") {
        throw new Error("expected verified");
      }

      // Replace TOTP inside the recovery window
      const t2 = new Date(t1.getTime() + 30_000);
      const started = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: recovery.tokens.accessToken,
        now: t2,
        adminRpId: ADMIN_RP_ID,
      });
      expect(started.outcome).toBe("started");
      if (started.outcome !== "started") {
        throw new Error("expected started");
      }
      const newKey = base32Decode(started.secret)!;
      const confirmed = await confirmTotpSetup(
        sql,
        kms,
        KEY_ARN,
        {
          accessToken: recovery.tokens.accessToken,
          now: t2,
          code: totpCode(newKey, stepAt(t2)),
          adminRpId: ADMIN_RP_ID,
        },
        { notice },
      );
      expect(confirmed).toEqual({ outcome: "confirmed" });

      // Attempting a fresh check in that recovery session with the newly set-up factor is refused
      const t3 = new Date(t2.getTime() + 30_000);
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: recovery.tokens.accessToken,
          now: t3,
          code: totpCode(newKey, stepAt(t3)),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // Even after the 10-minute recovery window ends, the recovery session still cannot pass a fresh check
      const t4 = new Date(t1.getTime() + TEN_MINUTES_MS + 30_000);
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: recovery.tokens.accessToken,
          now: t4,
          code: totpCode(newKey, stepAt(t4)),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      const accessHash = await sessionAccessHash(sql, kms, KEY_ARN, recovery.tokens.accessToken);
      const [row] = await sql<{ fresh_factor_at: Date | null }[]>`
        select fresh_factor_at from identity.sessions where access_hash = ${accessHash}
      `;
      expect(row?.fresh_factor_at).toBeNull();
    });
  });

  // Positive test (D-3)
  it("a factor set up in recovery passes a fresh check after a new sign-in", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "positive-d3@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const notice = new MemoryNotice();

      const sfRecovery = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const recovery = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sfRecovery.accessToken,
        now: t1,
        method: "backup_code",
        code: enrolled.backupCodes[0]!,
      });
      if (recovery.outcome !== "verified") {
        throw new Error("expected recovery session");
      }

      const t2 = new Date(t1.getTime() + 30_000);
      const started = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: recovery.tokens.accessToken,
        now: t2,
        adminRpId: ADMIN_RP_ID,
      });
      if (started.outcome !== "started") {
        throw new Error("expected started");
      }
      const newKey = base32Decode(started.secret)!;
      await confirmTotpSetup(
        sql,
        kms,
        KEY_ARN,
        {
          accessToken: recovery.tokens.accessToken,
          now: t2,
          code: totpCode(newKey, stepAt(t2)),
          adminRpId: ADMIN_RP_ID,
        },
        { notice },
      );

      // Recovery session itself still fails fresh check
      const t3 = new Date(t2.getTime() + 30_000);
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: recovery.tokens.accessToken,
          now: t3,
          code: totpCode(newKey, stepAt(t3)),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // New sign-in with the new factor
      const t4 = new Date(t3.getTime() + 30_000);
      const sfNew = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t4,
        kind: "second_factor",
      });
      const signedIn = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sfNew.accessToken,
        now: t4,
        method: "totp",
        code: totpCode(newKey, stepAt(t4)),
      });
      expect(signedIn.outcome).toBe("verified");
      if (signedIn.outcome !== "verified") {
        throw new Error("expected signedIn");
      }

      // Six minutes later (initial fresh window has expired), freshCheckTotp with newKey succeeds
      const t5 = new Date(t4.getTime() + 6 * 60 * 1000);
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: signedIn.tokens.accessToken,
          now: t5,
          code: totpCode(newKey, stepAt(t5)),
        }),
      ).resolves.toEqual({ outcome: "fresh" });

      const made = await regenerateBackupCodes(
        sql,
        kms,
        KEY_ARN,
        { accessToken: signedIn.tokens.accessToken, now: t5 },
        { notice },
      );
      expect(made.outcome).toBe("made");
    });
  });

  // Pin 46
  it("the recovery window ends after ten minutes", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin46@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const pkId = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const notice = new MemoryNotice();

      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const recovery = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now: t1,
        method: "backup_code",
        code: enrolled.backupCodes[0]!,
      });
      if (recovery.outcome !== "verified") {
        throw new Error("expected verified");
      }

      // At exactly 10 minutes (session is still active until 15 min), recovery actions are refused
      const atTenMin = new Date(t1.getTime() + TEN_MINUTES_MS);
      await expect(
        startTotpSetup(sql, kms, KEY_ARN, {
          accessToken: recovery.tokens.accessToken,
          now: atTenMin,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });
      await expect(
        regenerateBackupCodes(
          sql,
          kms,
          KEY_ARN,
          { accessToken: recovery.tokens.accessToken, now: atTenMin },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });
      await expect(
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: recovery.tokens.accessToken,
            now: atTenMin,
            adminRpId: ADMIN_RP_ID,
            passkeyId: pkId,
          },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      expect(notice.calls).toHaveLength(0);

      // 1 ms before 10 minutes, recovery action succeeds
      const beforeTenMin = new Date(t1.getTime() + TEN_MINUTES_MS - 1);
      const made = await regenerateBackupCodes(
        sql,
        kms,
        KEY_ARN,
        { accessToken: recovery.tokens.accessToken, now: beforeTenMin },
        { notice },
      );
      expect(made.outcome).toBe("made");
    });
  });

  // Pin 47
  it("a recovery session cannot remove the authenticator app", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin47@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      // Add a counting passkey so TOTP is not even the last factor
      await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const notice = new MemoryNotice();

      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const recovery = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now: t1,
        method: "backup_code",
        code: enrolled.backupCodes[0]!,
      });
      if (recovery.outcome !== "verified") {
        throw new Error("expected verified");
      }

      const inRecovery = new Date(t1.getTime() + 60_000);
      await expect(
        removeTotp(
          sql,
          kms,
          KEY_ARN,
          { accessToken: recovery.tokens.accessToken, now: inRecovery, adminRpId: ADMIN_RP_ID },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      expect(notice.calls).toHaveLength(0);
      const totpRows = await sql<{ id: string }[]>`
        select id from identity.totp_credentials where user_id = ${userId} and confirmed_at is not null
      `;
      expect(totpRows).toHaveLength(1);
    });
  });

  // Pin 48
  it("refuses removing the last factor even with backup codes left", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      // Case A: TOTP + 10 backup codes + non-counting passkey -> removeTotp refused
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin48-totp@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const totpUserId = enrolled.tokens.userId;
      // Non-counting passkeys must not count toward keeping a factor
      await sql`
        insert into identity.passkey_credentials (
          id, user_id, credential_id, cose_key, sign_count, rp_id, user_verified, created_at
        ) values
          (${newId()}, ${totpUserId}, ${crypto.getRandomValues(new Uint8Array(32))}, ${crypto.getRandomValues(new Uint8Array(32))}, 0, ${ADMIN_RP_ID}, false, ${now}),
          (${newId()}, ${totpUserId}, ${crypto.getRandomValues(new Uint8Array(32))}, ${crypto.getRandomValues(new Uint8Array(32))}, 0, ${null}, true, ${now})
      `;
      const freshTotp = await createSession(sql, kms, KEY_ARN, {
        userId: totpUserId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });
      const notice = new MemoryNotice();

      await expect(
        removeTotp(
          sql,
          kms,
          KEY_ARN,
          { accessToken: freshTotp.accessToken, now, adminRpId: ADMIN_RP_ID },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });
      expect(notice.calls).toHaveLength(0);
      const totpAfter = await sql<{ id: string }[]>`
        select id from identity.totp_credentials where user_id = ${totpUserId} and confirmed_at is not null
      `;
      expect(totpAfter).toHaveLength(1);

      // Case B: 1 counting passkey + 10 backup codes + no TOTP -> removePasskey refused
      const { userId: pkUserId } = await insertBackupCodeForTest(
        sql,
        kms,
        KEY_ARN,
        "pin48-pk@example.test",
        now,
      );
      await sql`delete from identity.totp_credentials where user_id = ${pkUserId}`;
      const pkId = await insertCountingPasskey(sql, pkUserId, ADMIN_RP_ID, now);
      const freshPk = await createSession(sql, kms, KEY_ARN, {
        userId: pkUserId,
        now,
        kind: "tenant",
        factor: "passkey_uv",
        freshFactorAt: now,
      });

      await expect(
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          { accessToken: freshPk.accessToken, now, adminRpId: ADMIN_RP_ID, passkeyId: pkId },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });
      expect(notice.calls).toHaveLength(0);
      const pkAfter = await sql<{ id: string }[]>`
        select id from identity.passkey_credentials where id = ${pkId}
      `;
      expect(pkAfter).toHaveLength(1);
    });
  });

  // Pin 49
  it("a recovery session cannot remove the last non-backup factor", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin49@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const pkId = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      // Remove TOTP from a fresh session so only the counting passkey + backup codes remain
      const fresh = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "passkey_uv",
        freshFactorAt: now,
      });
      const notice = new MemoryNotice();
      const removedTotp = await removeTotp(
        sql,
        kms,
        KEY_ARN,
        { accessToken: fresh.accessToken, now, adminRpId: ADMIN_RP_ID },
        { notice },
      );
      expect(removedTotp).toEqual({ outcome: "removed" });
      notice.calls.length = 0;

      // Sign in via backup code to open recovery window
      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const recovery = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now: t1,
        method: "backup_code",
        code: enrolled.backupCodes[0]!,
      });
      if (recovery.outcome !== "verified") {
        throw new Error("expected recovery");
      }

      // Removing the sole remaining passkey in recovery is refused
      await expect(
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: recovery.tokens.accessToken,
            now: new Date(t1.getTime() + 60_000),
            adminRpId: ADMIN_RP_ID,
            passkeyId: pkId,
          },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });
      expect(notice.calls).toHaveLength(0);
      const pkRows = await sql<{ id: string }[]>`
        select id from identity.passkey_credentials where id = ${pkId}
      `;
      expect(pkRows).toHaveLength(1);
    });
  });

  // Pin 50
  it("replacing the app ends the user's other admin sessions", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin50@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const notice = new MemoryNotice();

      const current = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: t1,
      });
      const otherTenant = enrolled.tokens;
      const otherSf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const opSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "operator",
        absoluteExpiresAt: new Date(t1.getTime() + HOUR_MS),
      });
      const enrolSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "enrolment",
      });

      const started = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: current.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
      });
      if (started.outcome !== "started") {
        throw new Error("expected started");
      }
      const newKey = base32Decode(started.secret)!;
      const confirmed = await confirmTotpSetup(
        sql,
        kms,
        KEY_ARN,
        {
          accessToken: current.accessToken,
          now: t1,
          code: totpCode(newKey, stepAt(t1)),
          adminRpId: ADMIN_RP_ID,
        },
        { notice },
      );
      expect(confirmed).toEqual({ outcome: "confirmed" });

      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: current.accessToken, now: t1 }),
      ).toEqual({ userId });
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: otherTenant.accessToken, now: t1 }),
      ).toBeNull();
      expect(
        await refreshSession(sql, kms, KEY_ARN, {
          refreshToken: otherTenant.refreshToken,
          now: t1,
        }),
      ).toBeNull();
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: otherSf.accessToken,
          now: t1,
          kinds: ["second_factor"],
        }),
      ).toBeNull();
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: opSession.accessToken,
          now: t1,
          kinds: ["operator"],
        }),
      ).toEqual({ userId, kind: "operator" });
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: enrolSession.accessToken,
          now: t1,
          kinds: ["enrolment"],
        }),
      ).toEqual({ userId, kind: "enrolment" });
    });
  });

  // Pin 51
  it("making new backup codes ends the user's other admin sessions", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin51@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const notice = new MemoryNotice();

      const current = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: t1,
      });
      const otherTenant = enrolled.tokens;
      const otherSf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const opSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "operator",
        absoluteExpiresAt: new Date(t1.getTime() + HOUR_MS),
      });
      const enrolSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "enrolment",
      });

      const made = await regenerateBackupCodes(
        sql,
        kms,
        KEY_ARN,
        { accessToken: current.accessToken, now: t1 },
        { notice },
      );
      expect(made.outcome).toBe("made");

      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: current.accessToken, now: t1 }),
      ).toEqual({ userId });
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: otherTenant.accessToken, now: t1 }),
      ).toBeNull();
      expect(
        await refreshSession(sql, kms, KEY_ARN, {
          refreshToken: otherTenant.refreshToken,
          now: t1,
        }),
      ).toBeNull();
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: otherSf.accessToken,
          now: t1,
          kinds: ["second_factor"],
        }),
      ).toBeNull();
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: opSession.accessToken,
          now: t1,
          kinds: ["operator"],
        }),
      ).toEqual({ userId, kind: "operator" });
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: enrolSession.accessToken,
          now: t1,
          kinds: ["enrolment"],
        }),
      ).toEqual({ userId, kind: "enrolment" });
    });
  });

  // Pin 52
  it("removing a factor ends the user's other admin sessions", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      // Remove TOTP ends other admin sessions and preserves operator/enrolment
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin52@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const pk1 = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const pk2 = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const notice = new MemoryNotice();

      const current = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "passkey_uv",
        freshFactorAt: t1,
      });
      const other1 = enrolled.tokens;
      const sf1 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const opSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "operator",
        absoluteExpiresAt: new Date(t1.getTime() + HOUR_MS),
      });
      const enrolSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "enrolment",
      });

      expect(
        await removeTotp(
          sql,
          kms,
          KEY_ARN,
          { accessToken: current.accessToken, now: t1, adminRpId: ADMIN_RP_ID },
          { notice },
        ),
      ).toEqual({ outcome: "removed" });

      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: current.accessToken, now: t1 }),
      ).toEqual({ userId });
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: other1.accessToken, now: t1 }),
      ).toBeNull();
      expect(
        await refreshSession(sql, kms, KEY_ARN, {
          refreshToken: other1.refreshToken,
          now: t1,
        }),
      ).toBeNull();
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: sf1.accessToken,
          now: t1,
          kinds: ["second_factor"],
        }),
      ).toBeNull();
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: opSession.accessToken,
          now: t1,
          kinds: ["operator"],
        }),
      ).toEqual({ userId, kind: "operator" });
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: enrolSession.accessToken,
          now: t1,
          kinds: ["enrolment"],
        }),
      ).toEqual({ userId, kind: "enrolment" });

      // Remove passkey also ends other admin sessions and preserves operator/enrolment
      const other2 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "passkey_uv",
      });
      const sf2 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      expect(
        await removePasskey(
          sql,
          kms,
          KEY_ARN,
          { accessToken: current.accessToken, now: t1, adminRpId: ADMIN_RP_ID, passkeyId: pk1 },
          { notice },
        ),
      ).toEqual({ outcome: "removed" });

      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: current.accessToken, now: t1 }),
      ).toEqual({ userId });
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: other2.accessToken, now: t1 }),
      ).toBeNull();
      expect(
        await refreshSession(sql, kms, KEY_ARN, {
          refreshToken: other2.refreshToken,
          now: t1,
        }),
      ).toBeNull();
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: sf2.accessToken,
          now: t1,
          kinds: ["second_factor"],
        }),
      ).toBeNull();
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: opSession.accessToken,
          now: t1,
          kinds: ["operator"],
        }),
      ).toEqual({ userId, kind: "operator" });
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: enrolSession.accessToken,
          now: t1,
          kinds: ["enrolment"],
        }),
      ).toEqual({ userId, kind: "enrolment" });

      const listed = await listSecondFactors(sql, kms, KEY_ARN, {
        accessToken: current.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
      });
      expect(listed.outcome).toBe("listed");
      if (listed.outcome === "listed") {
        expect(listed.passkeys.map((p) => p.id)).toEqual([pk2]);
      }
    });
  });

  // Pin 53
  it("adding a passkey in a recovery window ends the user's other admin sessions", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    const t2 = new Date(t1.getTime() + 60_000);
    await withSql(async (sql) => {
      const email = "pin53@example.test";
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const notice = new MemoryNotice();

      const otherTenant = enrolled.tokens;
      const otherSf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const opSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "operator",
        absoluteExpiresAt: new Date(t1.getTime() + HOUR_MS),
      });
      const enrolSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "enrolment",
      });

      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const recovery = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now: t1,
        method: "backup_code",
        code: enrolled.backupCodes[0]!,
      });
      expect(recovery.outcome).toBe("verified");
      if (recovery.outcome !== "verified") {
        throw new Error("expected recovery session");
      }

      const started = await beginTenantPasskeyRegistration(sql, kms, KEY_ARN, {
        accessToken: recovery.tokens.accessToken,
        now: t2,
        adminRpId: ADMIN_RP_ID,
      });
      expect(started.outcome).toBe("started");
      if (started.outcome !== "started") {
        throw new Error("expected started");
      }

      const pkKey = await generatePasskeySigner();
      const pkCredId = crypto.getRandomValues(new Uint8Array(16));
      const finished = await finishTenantPasskeyRegistration(
        sql,
        kms,
        KEY_ARN,
        {
          accessToken: recovery.tokens.accessToken,
          now: t2,
          adminRpId: ADMIN_RP_ID,
          clientDataJSON: clientDataBytes(
            "webauthn.create",
            started.options.challenge,
            ADMIN_ORIGIN,
          ),
          attestationObject: attestationObjectBytes(
            authenticatorDataBytes({
              rpId: ADMIN_RP_ID,
              signCount: 0,
              credentialId: pkCredId,
              cose: coseKeyBytes(pkKey.x, pkKey.y),
              flags: 0x45,
            }),
          ),
        },
        { notice },
      );
      expect(finished).toEqual({ outcome: "enrolled" });
      expect(notice.calls).toEqual([{ to: email, kind: "passkey_added" }]);

      expect(
        await readSession(sql, kms, KEY_ARN, {
          accessToken: recovery.tokens.accessToken,
          now: t2,
        }),
      ).toEqual({ userId });
      expect(
        await readSession(sql, kms, KEY_ARN, {
          accessToken: otherTenant.accessToken,
          now: t2,
        }),
      ).toBeNull();
      expect(
        await refreshSession(sql, kms, KEY_ARN, {
          refreshToken: otherTenant.refreshToken,
          now: t2,
        }),
      ).toBeNull();
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: otherSf.accessToken,
          now: t2,
          kinds: ["second_factor"],
        }),
      ).toBeNull();
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: opSession.accessToken,
          now: t2,
          kinds: ["operator"],
        }),
      ).toEqual({ userId, kind: "operator" });
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: enrolSession.accessToken,
          now: t2,
          kinds: ["enrolment"],
        }),
      ).toEqual({ userId, kind: "enrolment" });
    });
  });

  // Pin 54
  it("old backup codes stop working after new ones are made", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin54@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const notice = new MemoryNotice();

      const fresh = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: t1,
      });
      const made = await regenerateBackupCodes(
        sql,
        kms,
        KEY_ARN,
        { accessToken: fresh.accessToken, now: t1 },
        { notice },
      );
      expect(made.outcome).toBe("made");
      if (made.outcome !== "made") {
        throw new Error("expected made");
      }
      expect(made.backupCodes).toHaveLength(10);
      expect(new Set(made.backupCodes).size).toBe(10);
      for (const code of made.backupCodes) {
        expect(code).toMatch(/^[A-Z2-7]{12}$/);
      }

      const [rowCount] = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.backup_codes where user_id = ${userId}
      `;
      expect(rowCount?.n).toBe(10);

      // Old backup code is refused
      const sfOld = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sfOld.accessToken,
          now: t1,
          method: "backup_code",
          code: enrolled.backupCodes[0]!,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // New backup code works
      const sfNew = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const verifiedNew = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sfNew.accessToken,
        now: t1,
        method: "backup_code",
        code: made.backupCodes[0]!,
      });
      expect(verifiedNew.outcome).toBe("verified");
      if (verifiedNew.outcome === "verified") {
        expect(verifiedNew.backupCodesLeft).toBe(9);
      }
    });
  });

  // Pin 55
  it("removing the app deletes its secret", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin55@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const notice = new MemoryNotice();

      const fresh = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "passkey_uv",
        freshFactorAt: now,
      });
      // Start a replacement so pending_secret is also populated before removal
      await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: fresh.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });

      const removed = await removeTotp(
        sql,
        kms,
        KEY_ARN,
        { accessToken: fresh.accessToken, now, adminRpId: ADMIN_RP_ID },
        { notice },
      );
      expect(removed).toEqual({ outcome: "removed" });

      const rows = await sql<{ id: string }[]>`
        select id from identity.totp_credentials where user_id = ${userId}
      `;
      expect(rows).toHaveLength(0);

      const events = await sql<{ event: string }[]>`
        select event from identity.second_factor_events
        where user_id = ${userId} and event = 'totp_removed'
      `;
      expect(events).toHaveLength(1);
    });
  });

  // Pin 56
  it("removing a factor waits for the second factor lock", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const runtime = loadRuntime();
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    const sql = postgres(identityUrl(runtime), {
      max: 10,
      prepare: true,
      onnotice: () => undefined,
    });
    const holder = createPlaintextIdentitySql(identityUrl(runtime));
    const observer = createPlaintextDirectSql(runtime.productOnlyUrl);

    let releaseHolder: () => void = () => undefined;
    let holderPromise: Promise<void> | undefined;
    let removePromise: ReturnType<typeof removeTotp> | undefined;
    let removePkPromise: ReturnType<typeof removePasskey> | undefined;

    try {
      await clearIdentity(direct, sql);
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin56@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const pk1 = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const pk2 = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const notice = new MemoryNotice();
      const fresh = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "passkey_uv",
        freshFactorAt: now,
      });

      // 1. removeTotp waits for lockSecondFactor
      {
        const holderGate = new Promise<void>((resolve) => {
          releaseHolder = resolve;
        });
        let lockAcquiredNotify: () => void = () => undefined;
        const lockAcquired = new Promise<void>((resolve) => {
          lockAcquiredNotify = resolve;
        });
        let holderPid = 0;
        let settled = false;

        holderPromise = holder.begin(async (tx) => {
          const pidRows = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          holderPid = pidRows[0]!.pid;
          await lockSecondFactor(tx, userId);
          lockAcquiredNotify();
          await holderGate;
        });
        await Promise.race([lockAcquired, holderPromise]);

        removePromise = removeTotp(
          sql,
          kms,
          KEY_ARN,
          { accessToken: fresh.accessToken, now, adminRpId: ADMIN_RP_ID },
          { notice },
        ).finally(() => {
          settled = true;
        });

        const waiterFound = await waitForAdvisoryLockWaiter(
          observer,
          userId,
          holderPid,
          () => settled,
        );
        expect(waiterFound).toBe(true);
        expect(settled).toBe(false);

        releaseHolder();
        await holderPromise;
        expect(await removePromise).toEqual({ outcome: "removed" });
      }

      // 2. removePasskey waits for lockSecondFactor
      {
        const holderGate = new Promise<void>((resolve) => {
          releaseHolder = resolve;
        });
        let lockAcquiredNotify: () => void = () => undefined;
        const lockAcquired = new Promise<void>((resolve) => {
          lockAcquiredNotify = resolve;
        });
        let holderPid = 0;
        let settled = false;

        holderPromise = holder.begin(async (tx) => {
          const pidRows = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          holderPid = pidRows[0]!.pid;
          await lockSecondFactor(tx, userId);
          lockAcquiredNotify();
          await holderGate;
        });
        await Promise.race([lockAcquired, holderPromise]);

        removePkPromise = removePasskey(
          sql,
          kms,
          KEY_ARN,
          { accessToken: fresh.accessToken, now, adminRpId: ADMIN_RP_ID, passkeyId: pk1 },
          { notice },
        ).finally(() => {
          settled = true;
        });

        const waiterFound = await waitForAdvisoryLockWaiter(
          observer,
          userId,
          holderPid,
          () => settled,
        );
        expect(waiterFound).toBe(true);
        expect(settled).toBe(false);

        releaseHolder();
        await holderPromise;
        expect(await removePkPromise).toEqual({ outcome: "removed" });
      }

      // 3. Two parallel removals (TOTP vs last passkey, and two passkeys) leave one factor
      const enrolled2 = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin56-race@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const raceUserId = enrolled2.tokens.userId;
      const racePk = await insertCountingPasskey(sql, raceUserId, ADMIN_RP_ID, now);
      const raceFresh = await createSession(sql, kms, KEY_ARN, {
        userId: raceUserId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });

      const parallelMix = await Promise.all([
        removeTotp(
          sql,
          kms,
          KEY_ARN,
          { accessToken: raceFresh.accessToken, now, adminRpId: ADMIN_RP_ID },
          { notice },
        ),
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: raceFresh.accessToken,
            now,
            adminRpId: ADMIN_RP_ID,
            passkeyId: racePk,
          },
          { notice },
        ),
      ]);
      expect(parallelMix.filter((r) => r.outcome === "removed")).toHaveLength(1);
      expect(parallelMix.filter((r) => r.outcome === "refused")).toHaveLength(1);

      const listedRace = await listSecondFactors(sql, kms, KEY_ARN, {
        accessToken: raceFresh.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(listedRace.outcome).toBe("listed");
      if (listedRace.outcome === "listed") {
        const remainingCount = (listedRace.totp !== null ? 1 : 0) + listedRace.passkeys.length;
        expect(remainingCount).toBe(1);
      }

      // Parallel removal of two passkeys with no TOTP leaves one passkey (pk2 stays if one removed)
      const { userId: pkOnlyUser } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin56-pk-race@example.test",
      });
      const rpk1 = await insertCountingPasskey(sql, pkOnlyUser, ADMIN_RP_ID, now);
      const rpk2 = await insertCountingPasskey(sql, pkOnlyUser, ADMIN_RP_ID, now);
      const pkFresh = await createSession(sql, kms, KEY_ARN, {
        userId: pkOnlyUser,
        now,
        kind: "tenant",
        factor: "passkey_uv",
        freshFactorAt: now,
      });
      const parallelPks = await Promise.all([
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          { accessToken: pkFresh.accessToken, now, adminRpId: ADMIN_RP_ID, passkeyId: rpk1 },
          { notice },
        ),
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          { accessToken: pkFresh.accessToken, now, adminRpId: ADMIN_RP_ID, passkeyId: rpk2 },
          { notice },
        ),
      ]);
      expect(parallelPks.filter((r) => r.outcome === "removed")).toHaveLength(1);
      expect(parallelPks.filter((r) => r.outcome === "refused")).toHaveLength(1);
      const remainingPkRows = await sql<{ id: string }[]>`
        select id from identity.passkey_credentials where user_id = ${pkOnlyUser}
      `;
      expect(remainingPkRows).toHaveLength(1);
      expect(pk2).toBeDefined();
    } finally {
      releaseHolder();
      await removePromise?.catch(() => undefined);
      await removePkPromise?.catch(() => undefined);
      await holderPromise?.catch(() => undefined);
      await clearIdentity(direct, sql);
      await holder.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
      await sql.end({ timeout: 1 });
      await direct.end({ timeout: 1 });
    }
  }, 15_000);

  // Pin 57
  it("sends no notice for a refused change", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin57@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const notice = new MemoryNotice();
      const logCalls: SecondFactorNoticeLogFields[] = [];

      const stale = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: null,
      });
      const fresh = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });

      // Stale regenerateBackupCodes -> refused
      await expect(
        regenerateBackupCodes(
          sql,
          kms,
          KEY_ARN,
          { accessToken: stale.accessToken, now },
          { notice, log: (f) => logCalls.push(f) },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      // Wrong code on confirmTotpSetup -> refused
      await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: fresh.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      await expect(
        confirmTotpSetup(
          sql,
          kms,
          KEY_ARN,
          { accessToken: fresh.accessToken, now, code: "000000", adminRpId: ADMIN_RP_ID },
          { notice, log: (f) => logCalls.push(f) },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      // Removing last factor (TOTP with no counting passkey) -> refused
      await expect(
        removeTotp(
          sql,
          kms,
          KEY_ARN,
          { accessToken: fresh.accessToken, now, adminRpId: ADMIN_RP_ID },
          { notice, log: (f) => logCalls.push(f) },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      // Unknown passkey id -> refused
      await expect(
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: fresh.accessToken,
            now,
            adminRpId: ADMIN_RP_ID,
            passkeyId: newId(),
          },
          { notice, log: (f) => logCalls.push(f) },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      expect(notice.calls).toHaveLength(0);
      expect(logCalls).toHaveLength(0);
    });
  });

  // Pin 58
  it("a failed notice logs the kind only", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const email = "pin58-secret-owner@example.test";
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, { email });
      const pk1 = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "second_factor",
      });

      const sensitiveErrorMsg = `SES rejected ${email} with sensitive-detail`;
      const failingNotice: SecondFactorNotice = {
        send() {
          return Promise.reject(new Error(sensitiveErrorMsg));
        },
      };
      const logCalls: SecondFactorNoticeLogFields[] = [];
      const log = (fields: SecondFactorNoticeLogFields) => {
        logCalls.push(fields);
      };

      // Confirm TOTP setup still succeeds when notice fails
      const freshForConfirm = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "passkey_uv",
        freshFactorAt: now,
      });
      const started = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: freshForConfirm.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      if (started.outcome !== "started") {
        throw new Error("expected started");
      }
      const key = base32Decode(started.secret)!;
      const confirmed = await confirmTotpSetup(
        sql,
        kms,
        KEY_ARN,
        {
          accessToken: freshForConfirm.accessToken,
          now,
          code: totpCode(key, stepAt(now)),
          adminRpId: ADMIN_RP_ID,
        },
        { notice: failingNotice, log },
      );
      expect(confirmed).toEqual({ outcome: "confirmed" });

      // Regenerate backup codes still succeeds when rejectingSecondFactorNotice rejects
      const made = await regenerateBackupCodes(
        sql,
        kms,
        KEY_ARN,
        { accessToken: freshForConfirm.accessToken, now },
        { notice: rejectingSecondFactorNotice, log },
      );
      expect(made.outcome).toBe("made");

      // Remove passkey still succeeds when failingNotice rejects
      const removedPk = await removePasskey(
        sql,
        kms,
        KEY_ARN,
        { accessToken: freshForConfirm.accessToken, now, adminRpId: ADMIN_RP_ID, passkeyId: pk1 },
        { notice: failingNotice, log },
      );
      expect(removedPk).toEqual({ outcome: "removed" });

      // Remove TOTP (add a passkey first so TOTP isn't last)
      await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const removedTotp = await removeTotp(
        sql,
        kms,
        KEY_ARN,
        { accessToken: freshForConfirm.accessToken, now, adminRpId: ADMIN_RP_ID },
        { notice: failingNotice, log },
      );
      expect(removedTotp).toEqual({ outcome: "removed" });

      expect(logCalls).toEqual([
        { event: "second_factor_notice_failed", kind: "totp_set_up" },
        { event: "second_factor_notice_failed", kind: "backup_codes_made" },
        { event: "second_factor_notice_failed", kind: "passkey_removed" },
        { event: "second_factor_notice_failed", kind: "totp_removed" },
      ]);
      for (const call of logCalls) {
        expect(Object.keys(call).sort()).toEqual(["event", "kind"]);
      }
      const serialised = JSON.stringify(logCalls);
      expect(serialised).not.toContain(email);
      expect(serialised).not.toContain("example.test");
      expect(serialised).not.toContain(sensitiveErrorMsg);
      expect(serialised).not.toContain("stack");
      expect(sf.accessToken).toBeDefined();
    });
  });

  // Pin 59
  it("sends one notice for each change kind", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const email = "pin59@example.test";
    await withSql(async (sql) => {
      const notice = new MemoryNotice();
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email,
        now,
        adminRpId: ADMIN_RP_ID,
        notice,
      });
      const userId = enrolled.tokens.userId;
      const pkId = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const fresh = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });

      // Replacement TOTP confirm also sends totp_set_up
      const startedReplace = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: fresh.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      if (startedReplace.outcome !== "started") {
        throw new Error("expected startedReplace");
      }
      const replaceKey = base32Decode(startedReplace.secret)!;
      await confirmTotpSetup(
        sql,
        kms,
        KEY_ARN,
        {
          accessToken: fresh.accessToken,
          now,
          code: totpCode(replaceKey, stepAt(now)),
          adminRpId: ADMIN_RP_ID,
        },
        { notice },
      );

      // Regenerate backup codes sends backup_codes_made
      await regenerateBackupCodes(
        sql,
        kms,
        KEY_ARN,
        { accessToken: fresh.accessToken, now },
        { notice },
      );

      // Remove passkey sends passkey_removed
      await removePasskey(
        sql,
        kms,
        KEY_ARN,
        { accessToken: fresh.accessToken, now, adminRpId: ADMIN_RP_ID, passkeyId: pkId },
        { notice },
      );

      // Add another passkey so TOTP can be removed -> sends totp_removed
      await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      await removeTotp(
        sql,
        kms,
        KEY_ARN,
        { accessToken: fresh.accessToken, now, adminRpId: ADMIN_RP_ID },
        { notice },
      );

      expect(notice.calls).toEqual([
        { to: email, kind: "totp_set_up" },
        { to: email, kind: "totp_set_up" },
        { to: email, kind: "backup_codes_made" },
        { to: email, kind: "passkey_removed" },
        { to: email, kind: "totp_removed" },
      ]);
    });
  });

  // Pin 60
  it("the sixth wrong fresh answer in one admin session is refused and the session stays", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin60@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const rightCode = totpCode(enrolled.key, stepAt(t1));
      const wrongCode = rightCode === "000000" ? "111111" : "000000";

      const admin = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: null,
      });
      const accessHash = await sessionAccessHash(sql, kms, KEY_ARN, admin.accessToken);

      for (let i = 0; i < 5; i += 1) {
        await expect(
          freshCheckTotp(sql, kms, KEY_ARN, {
            accessToken: admin.accessToken,
            now: t1,
            code: wrongCode,
          }),
        ).resolves.toEqual({ outcome: "refused" });
      }

      // 6th wrong answer is limited
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: admin.accessToken,
          now: t1,
          code: wrongCode,
        }),
      ).resolves.toEqual({ outcome: "limited" });

      // Even a right answer on the 7th attempt is limited
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: admin.accessToken,
          now: t1,
          code: rightCode,
        }),
      ).resolves.toEqual({ outcome: "limited" });

      const [row] = await sql<
        { revoked_at: Date | null; fresh_factor_at: Date | null; second_factor_attempts: number }[]
      >`
        select revoked_at, fresh_factor_at, second_factor_attempts
        from identity.sessions
        where access_hash = ${accessHash}
      `;
      expect(row?.revoked_at).toBeNull();
      expect(row?.fresh_factor_at).toBeNull();
      expect(row?.second_factor_attempts).toBe(5);

      // The admin session itself stays active
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: admin.accessToken, now: t1 }),
      ).toEqual({ userId });
      const listed = await listSecondFactors(sql, kms, KEY_ARN, {
        accessToken: admin.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
      });
      expect(listed.outcome).toBe("listed");
    });
  });

  // Pin 61
  it("wrong fresh answers in two admin sessions count toward the hourly limit", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin61@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const rightCode = totpCode(enrolled.key, stepAt(t1));
      const wrongCode = rightCode === "000000" ? "111111" : "000000";

      const admin1 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "otp_totp",
      });
      const admin2 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "otp_totp",
      });

      for (let i = 0; i < 5; i += 1) {
        await expect(
          freshCheckTotp(sql, kms, KEY_ARN, {
            accessToken: admin1.accessToken,
            now: t1,
            code: wrongCode,
          }),
        ).resolves.toEqual({ outcome: "refused" });
      }
      const t2 = new Date(t1.getTime() + 60_000);
      for (let i = 0; i < 5; i += 1) {
        await expect(
          freshCheckTotp(sql, kms, KEY_ARN, {
            accessToken: admin2.accessToken,
            now: t2,
            code: wrongCode,
          }),
        ).resolves.toEqual({ outcome: "refused" });
      }

      // Within the hour, a third admin session and a pre-2FA session are both limited even with the right code
      const t3 = new Date(t1.getTime() + 59 * 60 * 1000);
      const admin3 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t3,
        kind: "tenant",
        factor: "otp_totp",
      });
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: admin3.accessToken,
          now: t3,
          code: totpCode(enrolled.key, stepAt(t3)),
        }),
      ).resolves.toEqual({ outcome: "limited" });

      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t3,
        kind: "second_factor",
      });
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sf.accessToken,
          now: t3,
          method: "totp",
          code: totpCode(enrolled.key, stepAt(t3)),
        }),
      ).resolves.toEqual({ outcome: "limited" });

      // Once the first 5 failures are at least 1 hour old, fresh check succeeds
      const t4 = new Date(t1.getTime() + HOUR_MS);
      const admin4 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t4,
        kind: "tenant",
        factor: "otp_totp",
      });
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: admin4.accessToken,
          now: t4,
          code: totpCode(enrolled.key, stepAt(t4)),
        }),
      ).resolves.toEqual({ outcome: "fresh" });
    });
  });

  // Pin 62
  it("the factor list leaves out passkeys from before this chunk", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin62@example.test",
      });
      const countingId = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      await sql`
        insert into identity.passkey_credentials (
          id, user_id, credential_id, cose_key, sign_count, rp_id, user_verified, created_at
        ) values
          (${newId()}, ${userId}, ${crypto.getRandomValues(new Uint8Array(32))}, ${crypto.getRandomValues(new Uint8Array(32))}, 0, ${ADMIN_RP_ID}, false, ${now}),
          (${newId()}, ${userId}, ${crypto.getRandomValues(new Uint8Array(32))}, ${crypto.getRandomValues(new Uint8Array(32))}, 0, ${null}, true, ${now}),
          (${newId()}, ${userId}, ${crypto.getRandomValues(new Uint8Array(32))}, ${crypto.getRandomValues(new Uint8Array(32))}, 0, ${"auth.example.test"}, true, ${now}),
          (${newId()}, ${userId}, ${crypto.getRandomValues(new Uint8Array(32))}, ${crypto.getRandomValues(new Uint8Array(32))}, 0, ${"ops.example.test"}, true, ${now})
      `;

      const session = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "passkey_uv",
      });

      const listed = await listSecondFactors(sql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(listed.outcome).toBe("listed");
      if (listed.outcome === "listed") {
        expect(listed.passkeys).toEqual([{ id: countingId, createdAt: now }]);
      }
    });
  });

  // Pin 63
  it("removing another user's passkey id answers as unknown and changes nothing", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      const enrolledA = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin63-a@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const pkA = await insertCountingPasskey(sql, enrolledA.tokens.userId, ADMIN_RP_ID, now);

      const enrolledB = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin63-b@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const pkB = await insertCountingPasskey(sql, enrolledB.tokens.userId, ADMIN_RP_ID, now);
      const nonCountingB = newId();
      await sql`
        insert into identity.passkey_credentials (
          id, user_id, credential_id, cose_key, sign_count, rp_id, user_verified, created_at
        ) values (
          ${nonCountingB}, ${enrolledB.tokens.userId}, ${crypto.getRandomValues(new Uint8Array(32))},
          ${crypto.getRandomValues(new Uint8Array(32))}, 0, ${ADMIN_RP_ID}, false, ${now}
        )
      `;

      const freshB = await createSession(sql, kms, KEY_ARN, {
        userId: enrolledB.tokens.userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });
      const notice = new MemoryNotice();

      // Another user's passkey id
      await expect(
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          { accessToken: freshB.accessToken, now, adminRpId: ADMIN_RP_ID, passkeyId: pkA },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      // Unknown UUID
      await expect(
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          { accessToken: freshB.accessToken, now, adminRpId: ADMIN_RP_ID, passkeyId: newId() },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      // Caller's own non-counting passkey id
      await expect(
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: freshB.accessToken,
            now,
            adminRpId: ADMIN_RP_ID,
            passkeyId: nonCountingB,
          },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      // Malformed id does not throw
      await expect(
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: freshB.accessToken,
            now,
            adminRpId: ADMIN_RP_ID,
            passkeyId: "not-a-uuid",
          },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      expect(notice.calls).toHaveLength(0);

      const remaining = await sql<{ id: string }[]>`
        select id from identity.passkey_credentials where id in (${pkA}, ${pkB}, ${nonCountingB})
      `;
      expect(remaining).toHaveLength(3);
      expect(
        await readSession(sql, kms, KEY_ARN, {
          accessToken: enrolledA.tokens.accessToken,
          now,
        }),
      ).toEqual({ userId: enrolledA.tokens.userId });
      expect(
        await readSession(sql, kms, KEY_ARN, {
          accessToken: enrolledB.tokens.accessToken,
          now,
        }),
      ).toEqual({ userId: enrolledB.tokens.userId });
    });
  });

  // Pin 110
  it("the second-factor service refuses a tenant session with no factor", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "pin110@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const pkId = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const notice = new MemoryNotice();

      const factorless = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: null,
        freshFactorAt: t1,
      });
      const factorlessHash = await sessionAccessHash(sql, kms, KEY_ARN, factorless.accessToken);

      const backupIdsBefore = await sql<{ id: string }[]>`
        select id from identity.backup_codes where user_id = ${userId} and used_at is null order by id
      `;
      const eventsBefore = await sql<{ id: string }[]>`
        select id from identity.second_factor_events where user_id = ${userId}
      `;

      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: factorless.accessToken,
          now: t1,
          code: totpCode(enrolled.key, stepAt(t1)),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      await expect(
        regenerateBackupCodes(
          sql,
          kms,
          KEY_ARN,
          { accessToken: factorless.accessToken, now: t1 },
          { notice },
        ).then((result) => result.outcome),
      ).resolves.toBe("refused");

      await expect(
        removeTotp(
          sql,
          kms,
          KEY_ARN,
          { accessToken: factorless.accessToken, now: t1, adminRpId: ADMIN_RP_ID },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      await expect(
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: factorless.accessToken,
            now: t1,
            adminRpId: ADMIN_RP_ID,
            passkeyId: pkId,
          },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      await expect(
        startTotpSetup(sql, kms, KEY_ARN, {
          accessToken: factorless.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
        }).then((result) => result.outcome),
      ).resolves.toBe("refused");

      await expect(
        listSecondFactors(sql, kms, KEY_ARN, {
          accessToken: factorless.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      expect(notice.calls).toHaveLength(0);

      const [totpRow] = await sql<
        {
          pending_secret: Uint8Array | null;
          confirmed_at: Date | null;
          last_used_step: number | string | null;
        }[]
      >`
        select pending_secret, confirmed_at, last_used_step
        from identity.totp_credentials
        where user_id = ${userId}
      `;
      expect(totpRow?.confirmed_at).toEqual(now);
      expect(totpRow?.pending_secret).toBeNull();
      expect(Number(totpRow?.last_used_step)).toBe(stepAt(now));

      const pkRows = await sql<{ id: string }[]>`
        select id from identity.passkey_credentials where id = ${pkId}
      `;
      expect(pkRows).toHaveLength(1);

      const backupIdsAfter = await sql<{ id: string }[]>`
        select id from identity.backup_codes where user_id = ${userId} and used_at is null order by id
      `;
      expect(backupIdsAfter).toEqual(backupIdsBefore);

      const eventsAfter = await sql<{ id: string }[]>`
        select id from identity.second_factor_events where user_id = ${userId}
      `;
      expect(eventsAfter).toEqual(eventsBefore);

      const [factorlessRow] = await sql<
        { second_factor_attempts: number; revoked_at: Date | null }[]
      >`
        select second_factor_attempts, revoked_at
        from identity.sessions
        where access_hash = ${factorlessHash}
      `;
      expect(factorlessRow?.second_factor_attempts).toBe(0);
      expect(factorlessRow?.revoked_at).toBeNull();

      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: enrolled.tokens.accessToken, now: t1 }),
      ).toEqual({ userId });
    });
  });

  // L4: caller's own non-counting passkeys
  it("removing your own passkey that does not count answers as unknown and changes nothing", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "own-non-counting-pk@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const countingPk = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const unverifiedPk = newId();
      const otherRpPk = newId();
      const nullRpPk = newId();
      await sql`
        insert into identity.passkey_credentials (
          id, user_id, credential_id, cose_key, sign_count, rp_id, user_verified, created_at
        ) values
          (${unverifiedPk}, ${userId}, ${crypto.getRandomValues(new Uint8Array(32))}, ${crypto.getRandomValues(new Uint8Array(32))}, 0, ${ADMIN_RP_ID}, false, ${now}),
          (${otherRpPk}, ${userId}, ${crypto.getRandomValues(new Uint8Array(32))}, ${crypto.getRandomValues(new Uint8Array(32))}, 0, ${"ops.example.test"}, true, ${now}),
          (${nullRpPk}, ${userId}, ${crypto.getRandomValues(new Uint8Array(32))}, ${crypto.getRandomValues(new Uint8Array(32))}, 0, ${null}, true, ${now})
      `;

      const fresh = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });
      const notice = new MemoryNotice();
      const eventsBefore = await sql<{ id: string }[]>`
        select id from identity.second_factor_events where user_id = ${userId}
      `;

      const unknownResult = await removePasskey(
        sql,
        kms,
        KEY_ARN,
        { accessToken: fresh.accessToken, now, adminRpId: ADMIN_RP_ID, passkeyId: newId() },
        { notice },
      );
      expect(unknownResult).toEqual({ outcome: "refused" });

      for (const passkeyId of [unverifiedPk, otherRpPk, nullRpPk]) {
        await expect(
          removePasskey(
            sql,
            kms,
            KEY_ARN,
            { accessToken: fresh.accessToken, now, adminRpId: ADMIN_RP_ID, passkeyId },
            { notice },
          ),
        ).resolves.toEqual(unknownResult);
      }

      expect(notice.calls).toHaveLength(0);
      const remaining = await sql<{ id: string }[]>`
        select id from identity.passkey_credentials
        where user_id = ${userId}
      `;
      expect(remaining.map((r) => r.id).sort()).toEqual(
        [countingPk, unverifiedPk, otherRpPk, nullRpPk].sort(),
      );
      const eventsAfter = await sql<{ id: string }[]>`
        select id from identity.second_factor_events where user_id = ${userId}
      `;
      expect(eventsAfter).toEqual(eventsBefore);
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: enrolled.tokens.accessToken, now }),
      ).toEqual({ userId });
    });
  });

  // Success-path tests
  it("freshCheckTotp advances last_used_step, rejects step replay and non-tenant callers, and enables factor management", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "fresh-success@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const pkId = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const notice = new MemoryNotice();

      // Non-tenant callers refused
      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const op = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "operator",
        absoluteExpiresAt: new Date(t1.getTime() + HOUR_MS),
      });
      const step1 = stepAt(t1);
      const code1 = totpCode(enrolled.key, step1);
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, { accessToken: sf.accessToken, now: t1, code: code1 }),
      ).resolves.toEqual({ outcome: "refused" });
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, { accessToken: op.accessToken, now: t1, code: code1 }),
      ).resolves.toEqual({ outcome: "refused" });
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, { accessToken: "invalid", now: t1, code: code1 }),
      ).resolves.toEqual({ outcome: "refused" });

      // Valid admin session passes fresh check
      const admin = enrolled.tokens;
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, { accessToken: admin.accessToken, now: t1, code: code1 }),
      ).resolves.toEqual({ outcome: "fresh" });

      // Same step cannot be replayed on a second admin session
      const admin2 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "otp_totp",
      });
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: admin2.accessToken,
          now: t1,
          code: code1,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // Factor list now reflects freshUntil = t1 + 5 minutes, and removePasskey succeeds
      const listed = await listSecondFactors(sql, kms, KEY_ARN, {
        accessToken: admin.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
      });
      expect(listed.outcome).toBe("listed");
      if (listed.outcome === "listed") {
        expect(listed.freshUntil).toEqual(new Date(t1.getTime() + FIVE_MINUTES_MS));
      }

      await expect(
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          { accessToken: admin.accessToken, now: t1, adminRpId: ADMIN_RP_ID, passkeyId: pkId },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "removed" });
      expect(notice.calls).toEqual([{ to: "fresh-success@example.test", kind: "passkey_removed" }]);
    });
  });

  it("allows removing a lost passkey in a recovery window when a confirmed TOTP or another passkey remains", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForManageTest(sql, kms, KEY_ARN, {
        email: "recovery-remove-pk@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const pkId = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const notice = new MemoryNotice();

      const otherTenant = enrolled.tokens;
      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const recovery = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now: t1,
        method: "backup_code",
        code: enrolled.backupCodes[0]!,
      });
      if (recovery.outcome !== "verified") {
        throw new Error("expected recovery");
      }

      const t2 = new Date(t1.getTime() + 60_000);
      await expect(
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: recovery.tokens.accessToken,
            now: t2,
            adminRpId: ADMIN_RP_ID,
            passkeyId: pkId,
          },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "removed" });

      expect(notice.calls).toEqual([
        { to: "recovery-remove-pk@example.test", kind: "passkey_removed" },
      ]);
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: otherTenant.accessToken, now: t2 }),
      ).toBeNull();

      // Also succeeds in recovery when two counting passkeys exist and no TOTP exists
      const { userId: twoPkUser } = await insertBackupCodeForTest(
        sql,
        kms,
        KEY_ARN,
        "recovery-two-pks@example.test",
        now,
      );
      await sql`delete from identity.totp_credentials where user_id = ${twoPkUser}`;
      const rpk1 = await insertCountingPasskey(sql, twoPkUser, ADMIN_RP_ID, now);
      const rpk2 = await insertCountingPasskey(sql, twoPkUser, ADMIN_RP_ID, now);
      const recSession = await createSession(sql, kms, KEY_ARN, {
        userId: twoPkUser,
        now: t1,
        kind: "tenant",
        factor: "otp_backup_code",
        recoveryUntil: new Date(t1.getTime() + TEN_MINUTES_MS),
      });
      await expect(
        removePasskey(
          sql,
          kms,
          KEY_ARN,
          { accessToken: recSession.accessToken, now: t2, adminRpId: ADMIN_RP_ID, passkeyId: rpk1 },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "removed" });
      const left = await sql<{ id: string }[]>`
        select id from identity.passkey_credentials where user_id = ${twoPkUser}
      `;
      expect(left.map((r) => r.id)).toEqual([rpk2]);
    });
  });
});
