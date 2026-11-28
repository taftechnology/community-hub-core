import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { type KmsPort } from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "@community-hub/db/plaintext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OtpMail } from "../domain/otp-mail.js";
import type { SecondFactorNotice, SecondFactorNoticeKind } from "../domain/second-factor-notice.js";
import { base32Decode, stepAt, totpCode } from "../domain/totp.js";
import {
  confirmTotpSetup,
  consumeFreshFactor,
  startEmailOtp,
  startTotpSetup,
  verifyEmailOtp,
  verifySecondStep,
} from "../public/index.js";
import { insertIdentityUser } from "./identity-user.js";
import { consumeFreshFactorInTx } from "./second-factor.js";
import { lockSecondFactor } from "./second-factor-lock.js";
import { createSession, sessionAccessHash } from "./session.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const ADMIN_RP_ID = "admin.example.test";
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

class MemoryMail implements OtpMail {
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

async function withSql<T>(run: (sql: Sql, direct: Sql) => Promise<T>): Promise<T> {
  const runtime = loadRuntime();
  const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
  const sql = createPlaintextIdentitySql(identityUrl(runtime));
  try {
    await clearIdentity(direct, sql);
    return await run(sql, direct);
  } finally {
    await clearIdentity(direct, sql);
    await sql.end({ timeout: 1 });
    await direct.end({ timeout: 1 });
  }
}

async function sessionIdForToken(sql: Sql, kms: KmsPort, accessToken: string): Promise<string> {
  const accessHash = await sessionAccessHash(sql, kms, KEY_ARN, accessToken);
  const rows = await sql<{ id: string }[]>`
    select id
    from identity.sessions
    where access_hash = ${accessHash}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("session row missing");
  }
  return row.id;
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

async function waitForRowLockWaiter(
  observer: Sql,
  holderPid: number,
  isSettled: () => boolean,
): Promise<boolean> {
  const pollStart = Date.now();
  while (Date.now() - pollStart < 5_000) {
    if (isSettled()) {
      return false;
    }
    const blockingRows = await observer<{ pid: number }[]>`
      select pid
      from pg_stat_activity
      where ${holderPid} = any(pg_blocking_pids(pid))
    `;
    if (blockingRows.length > 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return false;
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

describe("consumeFreshFactor", () => {
  const kms = createLocalKmsPort();

  // Pin 1
  it("a second consume after one success answers not_fresh", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "fc-pin1@example.test",
      });
      const session = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });

      const first = await consumeFreshFactor({
        sql,
        kms,
        keyArn: KEY_ARN,
        accessToken: session.accessToken,
        now,
      });
      expect(first).toEqual({ outcome: "consumed" });

      const second = await consumeFreshFactor({
        sql,
        kms,
        keyArn: KEY_ARN,
        accessToken: session.accessToken,
        now,
      });
      expect(second).toEqual({ outcome: "not_fresh" });

      const sessionId = await sessionIdForToken(sql, kms, session.accessToken);
      const [row] = await sql<{ fresh_factor_at: Date | null }[]>`
        select fresh_factor_at from identity.sessions where id = ${sessionId}
      `;
      expect(row?.fresh_factor_at).toBeNull();

      // Exact five-minute boundary is still valid and consumed once
      const atBoundary = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "passkey_uv",
        freshFactorAt: now,
      });
      const fiveMinutesLater = new Date(now.getTime() + FIVE_MINUTES_MS);
      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: atBoundary.accessToken,
          now: fiveMinutesLater,
        }),
      ).resolves.toEqual({ outcome: "consumed" });
      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: atBoundary.accessToken,
          now: fiveMinutesLater,
        }),
      ).resolves.toEqual({ outcome: "not_fresh" });
    });
  });

  // Pin 2
  it("two concurrent consumeFreshFactorInTx calls allow only one consume without an advisory lock", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    const runtime = loadRuntime();
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    const sql1 = postgres(identityUrl(runtime), {
      max: 1,
      prepare: true,
      onnotice: () => undefined,
    });
    const sql2 = postgres(identityUrl(runtime), {
      max: 1,
      prepare: true,
      onnotice: () => undefined,
    });
    const observer = createPlaintextDirectSql(runtime.productOnlyUrl);

    let releaseTx1: () => void = () => undefined;
    const tx1Gate = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });
    let markTx1Done: () => void = () => undefined;
    const tx1Consumed = new Promise<void>((resolve) => {
      markTx1Done = resolve;
    });
    let tx1Pid = 0;
    let tx2Settled = false;
    let tx1Promise: Promise<{ outcome: string }> | undefined;
    let tx2Promise: Promise<{ outcome: string }> | undefined;

    try {
      await clearIdentity(direct, sql1);
      const { userId } = await insertIdentityUser(sql1, kms, KEY_ARN, {
        email: "fc-pin2@example.test",
      });
      const session = await createSession(sql1, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });
      const sessionId = await sessionIdForToken(sql1, kms, session.accessToken);

      tx1Promise = sql1.begin(async (tx1) => {
        const pidRows = await tx1<{ pid: number }[]>`select pg_backend_pid() as pid`;
        tx1Pid = pidRows[0]!.pid;
        const result = await consumeFreshFactorInTx(tx1, { sessionId, now });
        markTx1Done();
        await tx1Gate;
        return result;
      });
      await Promise.race([tx1Consumed, tx1Promise]);

      tx2Promise = sql2
        .begin((tx2) => consumeFreshFactorInTx(tx2, { sessionId, now }))
        .finally(() => {
          tx2Settled = true;
        });

      const waiterFound = await waitForRowLockWaiter(observer, tx1Pid, () => tx2Settled);
      expect(waiterFound).toBe(true);
      expect(tx2Settled).toBe(false);

      releaseTx1();
      expect(await tx1Promise).toEqual({ outcome: "consumed" });
      expect(await tx2Promise).toEqual({ outcome: "not_fresh" });
    } finally {
      releaseTx1();
      await tx2Promise?.catch(() => undefined);
      await tx1Promise?.catch(() => undefined);
      await clearIdentity(direct, sql1);
      await observer.end({ timeout: 1 });
      await sql2.end({ timeout: 1 });
      await sql1.end({ timeout: 1 });
      await direct.end({ timeout: 1 });
    }
  }, 15_000);

  // Pin 2b
  it("consumeFreshFactor waits for the user's second-factor advisory lock", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    const runtime = loadRuntime();
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    const sql = createPlaintextIdentitySql(identityUrl(runtime));
    const holder = createPlaintextIdentitySql(identityUrl(runtime));
    const observer = createPlaintextDirectSql(runtime.productOnlyUrl);

    let releaseHolder: () => void = () => undefined;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let lockAcquiredNotify: () => void = () => undefined;
    const lockAcquired = new Promise<void>((resolve) => {
      lockAcquiredNotify = resolve;
    });
    let holderPid = 0;
    let settled = false;
    let holderPromise: Promise<void> | undefined;
    let consumePromise: ReturnType<typeof consumeFreshFactor> | undefined;

    try {
      await clearIdentity(direct, sql);
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "fc-pin2b@example.test",
      });
      const session = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });

      holderPromise = holder.begin(async (tx) => {
        const pidRows = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        holderPid = pidRows[0]!.pid;
        await lockSecondFactor(tx, userId);
        lockAcquiredNotify();
        await holderGate;
      });
      await Promise.race([lockAcquired, holderPromise]);

      consumePromise = consumeFreshFactor({
        sql,
        kms,
        keyArn: KEY_ARN,
        accessToken: session.accessToken,
        now,
      }).finally(() => {
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
      const result = await consumePromise;
      expect(settled).toBe(true);
      expect(result).toEqual({ outcome: "consumed" });
    } finally {
      releaseHolder();
      await consumePromise?.catch(() => undefined);
      await holderPromise?.catch(() => undefined);
      await clearIdentity(direct, sql);
      await holder.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
      await sql.end({ timeout: 1 });
      await direct.end({ timeout: 1 });
    }
  }, 15_000);

  // Pin 3
  it("a recovery session answers recovery, never not_fresh or consumed", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "fc-pin3@example.test",
      });

      const recovery = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_backup_code",
        freshFactorAt: null,
        recoveryUntil: new Date(now.getTime() + TEN_MINUTES_MS),
      });

      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: recovery.accessToken,
          now: new Date(now.getTime() + 60_000),
        }),
      ).resolves.toEqual({ outcome: "recovery" });

      // Even after the 10-minute recovery window ends, recovery_until stays set
      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: recovery.accessToken,
          now: new Date(now.getTime() + TEN_MINUTES_MS + 1),
        }),
      ).resolves.toEqual({ outcome: "recovery" });

      // Even if a recovery session row carried a fresh timestamp, recovery is answered first
      const recoveryWithFresh = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_backup_code",
        freshFactorAt: now,
        recoveryUntil: new Date(now.getTime() + TEN_MINUTES_MS),
      });
      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: recoveryWithFresh.accessToken,
          now,
        }),
      ).resolves.toEqual({ outcome: "recovery" });

      const sessionId = await sessionIdForToken(sql, kms, recoveryWithFresh.accessToken);
      const [row] = await sql<{ fresh_factor_at: Date | null }[]>`
        select fresh_factor_at from identity.sessions where id = ${sessionId}
      `;
      expect(row?.fresh_factor_at).toEqual(now);
    });
  });

  // Pin 4
  it("a second_factor session with a fresh time answers not_fresh", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "fc-pin4@example.test",
      });

      const pre2fa = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "second_factor",
        freshFactorAt: now,
      });
      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: pre2fa.accessToken,
          now,
        }),
      ).resolves.toEqual({ outcome: "not_fresh" });

      const pre2faId = await sessionIdForToken(sql, kms, pre2fa.accessToken);
      const [pre2faRow] = await sql<{ fresh_factor_at: Date | null }[]>`
        select fresh_factor_at from identity.sessions where id = ${pre2faId}
      `;
      expect(pre2faRow?.fresh_factor_at).toEqual(now);

      const opSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "operator",
        absoluteExpiresAt: new Date(now.getTime() + HOUR_MS),
        freshFactorAt: now,
      });
      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: opSession.accessToken,
          now,
        }),
      ).resolves.toEqual({ outcome: "not_fresh" });

      const enrolSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "enrolment",
        freshFactorAt: now,
      });
      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: enrolSession.accessToken,
          now,
        }),
      ).resolves.toEqual({ outcome: "not_fresh" });
    });
  });

  // Pin 5
  it("a revoked session answers not_fresh", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "fc-pin5@example.test",
      });
      const revoked = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });
      const sessionId = await sessionIdForToken(sql, kms, revoked.accessToken);
      await sql`
        update identity.sessions
        set revoked_at = ${now.toISOString()}::timestamptz
        where id = ${sessionId}
      `;

      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: revoked.accessToken,
          now,
        }),
      ).resolves.toEqual({ outcome: "not_fresh" });

      const [row] = await sql<{ fresh_factor_at: Date | null }[]>`
        select fresh_factor_at from identity.sessions where id = ${sessionId}
      `;
      expect(row?.fresh_factor_at).toEqual(now);
    });
  });

  // Pin 6
  it("a check 5 minutes and 1 second old answers not_fresh", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "fc-pin6@example.test",
      });
      const session = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });

      const expiredAt = new Date(now.getTime() + FIVE_MINUTES_MS + 1000);
      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: session.accessToken,
          now: expiredAt,
        }),
      ).resolves.toEqual({ outcome: "not_fresh" });

      const sessionId = await sessionIdForToken(sql, kms, session.accessToken);
      const [row] = await sql<{ fresh_factor_at: Date | null }[]>`
        select fresh_factor_at from identity.sessions where id = ${sessionId}
      `;
      expect(row?.fresh_factor_at).toEqual(now);
    });
  });

  // Pin 122
  it("a session whose access token has expired answers not_fresh and keeps its fresh check", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "fc-pin122@example.test",
      });

      // Two identical rows. Each one gets a fresh check that is one minute old at the moment its
      // access token expires, so the expiry is the only reason the second row can be refused.
      async function sessionWithFreshCheckBeforeExpiry(): Promise<{
        accessToken: string;
        sessionId: string;
        accessExpiresAt: Date;
        freshFactorAt: Date;
      }> {
        const created = await createSession(sql, kms, KEY_ARN, {
          userId,
          now,
          kind: "tenant",
          factor: "otp_totp",
          freshFactorAt: now,
        });
        const sessionId = await sessionIdForToken(sql, kms, created.accessToken);
        const [row] = await sql<{ access_expires_at: Date; fresh_factor_at: Date }[]>`
          update identity.sessions
          set fresh_factor_at = access_expires_at - interval '1 minute'
          where id = ${sessionId}
          returning access_expires_at, fresh_factor_at
        `;
        if (row === undefined) {
          throw new Error("session row missing");
        }
        return {
          accessToken: created.accessToken,
          sessionId,
          accessExpiresAt: row.access_expires_at,
          freshFactorAt: row.fresh_factor_at,
        };
      }

      // Control: one millisecond before the expiry the same kind of row is consumed.
      const control = await sessionWithFreshCheckBeforeExpiry();
      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: control.accessToken,
          now: new Date(control.accessExpiresAt.getTime() - 1),
        }),
      ).resolves.toEqual({ outcome: "consumed" });

      // At the expiry instant and after it, the fresh check is still inside its window and is
      // still not consumed.
      const expired = await sessionWithFreshCheckBeforeExpiry();
      for (const at of [
        expired.accessExpiresAt,
        new Date(expired.accessExpiresAt.getTime() + 1000),
      ]) {
        await expect(
          consumeFreshFactor({
            sql,
            kms,
            keyArn: KEY_ARN,
            accessToken: expired.accessToken,
            now: at,
          }),
        ).resolves.toEqual({ outcome: "not_fresh" });
      }

      const [after] = await sql<{ fresh_factor_at: Date | null }[]>`
        select fresh_factor_at from identity.sessions where id = ${expired.sessionId}
      `;
      expect(after?.fresh_factor_at).toEqual(expired.freshFactorAt);
    });
  });

  // Pin 123
  it("a tenant session with no factor answers not_fresh and keeps its fresh check", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "fc-pin123@example.test",
      });

      // Control: a tenant session with a factor and a fresh check is consumed.
      const control = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });
      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: control.accessToken,
          now,
        }),
      ).resolves.toEqual({ outcome: "consumed" });

      // A tenant row with no factor is what an image from before the second factor left behind.
      // The service no longer mints one, so the test clears the factor of a fresh session.
      const factorless = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });
      const factorlessId = await sessionIdForToken(sql, kms, factorless.accessToken);
      await sql`update identity.sessions set factor = null where id = ${factorlessId}`;

      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: factorless.accessToken,
          now,
        }),
      ).resolves.toEqual({ outcome: "not_fresh" });

      const [row] = await sql<
        { kind: string; factor: string | null; fresh_factor_at: Date | null }[]
      >`
        select kind, factor, fresh_factor_at from identity.sessions where id = ${factorlessId}
      `;
      expect(row?.kind).toBe("tenant");
      expect(row?.factor).toBeNull();
      expect(row?.fresh_factor_at).toEqual(now);
    });
  });

  it("answers not_fresh for a missing check or unknown token and consumes a sign-in second step once", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    await withSql(async (sql) => {
      const email = "fc-signin@example.test";
      const mail = new MemoryMail();
      await startEmailOtp(sql, kms, KEY_ARN, mail, { email, now });
      const verifiedEmail = await verifyEmailOtp(sql, kms, KEY_ARN, {
        email,
        code: mail.last?.code ?? "",
        now,
      });
      if (verifiedEmail === null) {
        throw new Error("expected verifiedEmail");
      }
      const pre2fa = await createSession(sql, kms, KEY_ARN, {
        userId: verifiedEmail.userId,
        now,
        kind: "second_factor",
      });
      const started = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: pre2fa.accessToken,
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
          accessToken: pre2fa.accessToken,
          now,
          code: totpCode(key, stepAt(now)),
          adminRpId: ADMIN_RP_ID,
        },
        { notice: new MemoryNotice() },
      );
      if (confirmed.outcome !== "confirmed" || !confirmed.tokens) {
        throw new Error("expected confirmed");
      }

      // First setup has no fresh check
      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: confirmed.tokens.accessToken,
          now,
        }),
      ).resolves.toEqual({ outcome: "not_fresh" });

      // Invalid/unknown token
      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: "not-a-valid-token",
          now,
        }),
      ).resolves.toEqual({ outcome: "not_fresh" });

      // Sign-in second step by TOTP counts as fresh and is consumed once
      const t1 = new Date(now.getTime() + 30_000);
      const sf = await createSession(sql, kms, KEY_ARN, {
        userId: verifiedEmail.userId,
        now: t1,
        kind: "second_factor",
      });
      const signedIn = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now: t1,
        method: "totp",
        code: totpCode(key, stepAt(t1)),
      });
      if (signedIn.outcome !== "verified") {
        throw new Error("expected verified");
      }

      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: signedIn.tokens.accessToken,
          now: t1,
        }),
      ).resolves.toEqual({ outcome: "consumed" });
      await expect(
        consumeFreshFactor({
          sql,
          kms,
          keyArn: KEY_ARN,
          accessToken: signedIn.tokens.accessToken,
          now: t1,
        }),
      ).resolves.toEqual({ outcome: "not_fresh" });
    });
  });
});
