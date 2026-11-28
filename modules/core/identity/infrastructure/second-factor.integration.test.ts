import { createHash, generateKeyPairSync, sign as signDer } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { decrypt, encrypt, type KmsPort } from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "@community-hub/db/plaintext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encodeCbor, type Cbor } from "../domain/cbor.js";
import type { OtpMail } from "../domain/otp-mail.js";
import type { SecondFactorNotice, SecondFactorNoticeKind } from "../domain/second-factor-notice.js";
import { base32Decode, base32Encode, newTotpKey, stepAt, totpCode } from "../domain/totp.js";
import {
  beginFreshPasskey,
  beginTenantPasskeyRegistration,
  confirmTotpSetup,
  endSession,
  finishTenantPasskeyRegistration,
  freshCheckTotp,
  listSecondFactors,
  readSessionWithKind,
  refreshSession,
  startEmailOtp,
  startTotpSetup,
  verifyEmailOtp,
  verifyFreshPasskey,
  verifySecondStep,
} from "../public/index.js";
import { deriveIdentityEmailKeys } from "./email-lookup.js";
import { insertIdentityUser } from "./identity-user.js";
import { hasSecondFactor } from "./second-factor.js";
import { lockSecondFactor } from "./second-factor-lock.js";
import { createSession, sessionAccessHash, type SessionTokens } from "./session.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const ADMIN_RP_ID = "admin.example.test";
const ADMIN_ORIGIN = "https://admin.example.test";
const RFC_6238_KEY = new TextEncoder().encode("12345678901234567890");
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

// Test-only fixture helper placed in second-factor.integration.test.ts rather
// than second-factor.fixture.ts because modules/core/identity/tsconfig.json
// excludes only **/*.test.ts from the build output.
export async function enrolTotpForTest(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: { email: string; now: Date; adminRpId: string | null; notice?: SecondFactorNotice },
): Promise<{ tokens: SessionTokens; key: Uint8Array; backupCodes: string[] }> {
  const mail = new MemoryMail();
  await startEmailOtp(sql, kms, keyArn, mail, { email: input.email, now: input.now });
  const emailCode = mail.last?.code ?? "";
  const verified = await verifyEmailOtp(sql, kms, keyArn, {
    email: input.email,
    code: emailCode,
    now: input.now,
  });
  if (verified === null) {
    throw new Error("email verification failed in enrolTotpForTest");
  }
  const sessionInfo = await readSessionWithKind(sql, kms, keyArn, {
    accessToken: verified.accessToken,
    now: input.now,
    kinds: ["tenant", "second_factor"],
  });
  if (sessionInfo === null) {
    throw new Error("email session missing in enrolTotpForTest");
  }
  let pre2faToken = verified.accessToken;
  if (sessionInfo.kind === "tenant") {
    await endSession(sql, kms, keyArn, { accessToken: verified.accessToken, now: input.now });
    const pre2fa = await createSession(sql, kms, keyArn, {
      userId: verified.userId,
      now: input.now,
      kind: "second_factor",
    });
    pre2faToken = pre2fa.accessToken;
  }
  const started = await startTotpSetup(sql, kms, keyArn, {
    accessToken: pre2faToken,
    now: input.now,
    adminRpId: input.adminRpId,
  });
  if (started.outcome !== "started") {
    throw new Error("startTotpSetup failed in enrolTotpForTest");
  }
  const key = base32Decode(started.secret);
  if (key === null) {
    throw new Error("invalid base32 secret in enrolTotpForTest");
  }
  const confirmed = await confirmTotpSetup(
    sql,
    kms,
    keyArn,
    {
      accessToken: pre2faToken,
      now: input.now,
      code: totpCode(key, stepAt(input.now)),
      adminRpId: input.adminRpId,
    },
    { notice: input.notice ?? new MemoryNotice() },
  );
  if (confirmed.outcome !== "confirmed" || !confirmed.tokens || !confirmed.backupCodes) {
    throw new Error("confirmTotpSetup failed in enrolTotpForTest");
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

describe("second-factor service: TOTP, backup codes, second step, limits", () => {
  const kms = createLocalKmsPort();

  // Pin 25
  it("refuses the same TOTP step twice", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin25@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const confirmStep = stepAt(now);

      // Confirmation already consumed confirmStep
      const sf0 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "second_factor",
      });
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sf0.accessToken,
          now,
          method: "totp",
          code: totpCode(enrolled.key, confirmStep),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // Advance to the next step
      const t1 = new Date(now.getTime() + 30_000);
      const step1 = stepAt(t1);
      const code1 = totpCode(enrolled.key, step1);

      const sf1 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const first = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf1.accessToken,
        now: t1,
        method: "totp",
        code: code1,
      });
      expect(first.outcome).toBe("verified");

      // Replaying the same step on another pre-2FA session in the same step window is refused
      const sf2 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sf2.accessToken,
          now: t1,
          method: "totp",
          code: code1,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // Replaying step1 at step1 + 1 (where step1 would otherwise match as t - 1) is also refused
      const t2 = new Date(t1.getTime() + 30_000);
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sf2.accessToken,
          now: t2,
          method: "totp",
          code: code1,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      const [cred] = await sql<{ last_used_step: number | string | null }[]>`
        select last_used_step from identity.totp_credentials where user_id = ${userId}
      `;
      expect(Number(cred?.last_used_step)).toBe(step1);

      // Next unused step succeeds
      const sf3 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t2,
        kind: "second_factor",
      });
      const third = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf3.accessToken,
        now: t2,
        method: "totp",
        code: totpCode(enrolled.key, stepAt(t2)),
      });
      expect(third.outcome).toBe("verified");
    });
  });

  // Pin 26
  it("a right answer after five wrong ones is refused", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin26@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const rightCode = totpCode(enrolled.key, stepAt(t1));
      const wrongCode = rightCode === "000000" ? "111111" : "000000";

      const sf1 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      for (let i = 0; i < 5; i += 1) {
        await expect(
          verifySecondStep(sql, kms, KEY_ARN, {
            accessToken: sf1.accessToken,
            now: t1,
            method: "totp",
            code: wrongCode,
          }),
        ).resolves.toEqual({ outcome: "refused" });
      }
      const afterFive = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf1.accessToken,
        now: t1,
        method: "totp",
        code: rightCode,
      });
      expect(afterFive.outcome).not.toBe("verified");

      // Also directly verify the pre-compare second_factor_attempts < 5 gate on an unrevoked row
      const sf2 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const sf2Hash = await sessionAccessHash(sql, kms, KEY_ARN, sf2.accessToken);
      await sql`
        update identity.sessions
        set second_factor_attempts = 5
        where access_hash = ${sf2Hash}
      `;
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sf2.accessToken,
          now: t1,
          method: "totp",
          code: rightCode,
        }),
      ).resolves.toEqual({ outcome: "limited" });

      const tenantRows = await sql<{ n: number }[]>`
        select count(*)::int as n
        from identity.sessions
        where user_id = ${userId} and kind = 'tenant' and revoked_at is null
      `;
      expect(tenantRows[0]?.n).toBe(1);

      // Four wrong answers followed by a right fifth answer succeeds
      const sf3 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      for (let i = 0; i < 4; i += 1) {
        await expect(
          verifySecondStep(sql, kms, KEY_ARN, {
            accessToken: sf3.accessToken,
            now: t1,
            method: "totp",
            code: wrongCode,
          }),
        ).resolves.toEqual({ outcome: "refused" });
      }
      const fifthRight = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf3.accessToken,
        now: t1,
        method: "totp",
        code: rightCode,
      });
      expect(fifthRight.outcome).toBe("verified");
    });
  });

  // Pin 27
  it("the fifth wrong answer revokes the pre-2FA session", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin27@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const rightCode = totpCode(enrolled.key, stepAt(t1));
      const wrongCode = rightCode === "000000" ? "111111" : "000000";

      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const sfHash = await sessionAccessHash(sql, kms, KEY_ARN, sf.accessToken);

      for (let i = 0; i < 4; i += 1) {
        await expect(
          verifySecondStep(sql, kms, KEY_ARN, {
            accessToken: sf.accessToken,
            now: t1,
            method: "totp",
            code: wrongCode,
          }),
        ).resolves.toEqual({ outcome: "refused" });
      }
      const [afterFour] = await sql<{ revoked_at: Date | null; second_factor_attempts: number }[]>`
        select revoked_at, second_factor_attempts
        from identity.sessions
        where access_hash = ${sfHash}
      `;
      expect(afterFour?.revoked_at).toBeNull();
      expect(afterFour?.second_factor_attempts).toBe(4);

      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sf.accessToken,
          now: t1,
          method: "totp",
          code: wrongCode,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      const [afterFive] = await sql<{ revoked_at: Date | null; second_factor_attempts: number }[]>`
        select revoked_at, second_factor_attempts
        from identity.sessions
        where access_hash = ${sfHash}
      `;
      expect(afterFive?.revoked_at).toEqual(t1);
      expect(afterFive?.second_factor_attempts).toBe(5);

      const [events] = await sql<{ n: number }[]>`
        select count(*)::int as n
        from identity.second_factor_events
        where user_id = ${userId} and event = 'verify_failed'
      `;
      expect(events?.n).toBe(5);
    });
  });

  // Pin 28
  it("refuses the second step after ten wrong answers in an hour", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin28@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const rightCode = totpCode(enrolled.key, stepAt(t1));
      const wrongCode = rightCode === "000000" ? "111111" : "000000";

      const sf1 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      for (let i = 0; i < 5; i += 1) {
        await expect(
          verifySecondStep(sql, kms, KEY_ARN, {
            accessToken: sf1.accessToken,
            now: t1,
            method: "totp",
            code: wrongCode,
          }),
        ).resolves.toEqual({ outcome: "refused" });
      }

      const t2 = new Date(t1.getTime() + 60_000);
      const sf2 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t2,
        kind: "second_factor",
      });
      for (let i = 0; i < 5; i += 1) {
        await expect(
          verifySecondStep(sql, kms, KEY_ARN, {
            accessToken: sf2.accessToken,
            now: t2,
            method: "backup_code",
            code: "AAAAAAAAAAAA",
          }),
        ).resolves.toEqual({ outcome: "refused" });
      }

      // Within the hour, a third pre-2FA session is limited even with the right TOTP or backup code
      const t3 = new Date(t1.getTime() + 59 * 60 * 1000);
      const sf3 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t3,
        kind: "second_factor",
      });
      const sf3Hash = await sessionAccessHash(sql, kms, KEY_ARN, sf3.accessToken);
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sf3.accessToken,
          now: t3,
          method: "totp",
          code: totpCode(enrolled.key, stepAt(t3)),
        }),
      ).resolves.toEqual({ outcome: "limited" });
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sf3.accessToken,
          now: t3,
          method: "backup_code",
          code: enrolled.backupCodes[0]!,
        }),
      ).resolves.toEqual({ outcome: "limited" });

      // Hourly limit stops before incrementing second_factor_attempts
      const [sf3Row] = await sql<{ second_factor_attempts: number }[]>`
        select second_factor_attempts from identity.sessions where access_hash = ${sf3Hash}
      `;
      expect(sf3Row?.second_factor_attempts).toBe(0);

      // Once the first 5 failures are at least 1 hour old (t4 = t1 + 1 hour), only 5 remain in the window
      const t4 = new Date(t1.getTime() + HOUR_MS);
      const sf4 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t4,
        kind: "second_factor",
      });
      const allowed = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf4.accessToken,
        now: t4,
        method: "totp",
        code: totpCode(enrolled.key, stepAt(t4)),
      });
      expect(allowed.outcome).toBe("verified");
    });
  });

  // Pin 29
  it("the second step waits for the second factor lock", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
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
    let verifyPromise: ReturnType<typeof verifySecondStep> | undefined;

    try {
      await clearIdentity(direct, sql);
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin29@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });

      holderPromise = holder.begin(async (tx) => {
        const pidRows = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        holderPid = pidRows[0]!.pid;
        await lockSecondFactor(tx, userId);
        lockAcquiredNotify();
        await holderGate;
      });
      await Promise.race([lockAcquired, holderPromise]);

      verifyPromise = verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now: t1,
        method: "totp",
        code: totpCode(enrolled.key, stepAt(t1)),
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
      const result = await verifyPromise;
      expect(settled).toBe(true);
      expect(result.outcome).toBe("verified");

      // Also asserts that two parallel right answers on one pre-2FA session give one admin session
      const t2 = new Date(t1.getTime() + 30_000);
      const sfParallel = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t2,
        kind: "second_factor",
      });
      const code2 = totpCode(enrolled.key, stepAt(t2));
      const parallelResults = await Promise.all([
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sfParallel.accessToken,
          now: t2,
          method: "totp",
          code: code2,
        }),
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sfParallel.accessToken,
          now: t2,
          method: "totp",
          code: code2,
        }),
      ]);
      expect(parallelResults.filter((r) => r.outcome === "verified")).toHaveLength(1);
      expect(parallelResults.filter((r) => r.outcome === "refused")).toHaveLength(1);

      const tenantRows = await sql<{ n: number }[]>`
        select count(*)::int as n
        from identity.sessions
        where user_id = ${userId} and kind = 'tenant' and revoked_at is null
      `;
      expect(tenantRows[0]?.n).toBe(3); // 1 from enrol + 1 from lock test + 1 from parallel test
    } finally {
      releaseHolder();
      await verifyPromise?.catch(() => undefined);
      await holderPromise?.catch(() => undefined);
      await clearIdentity(direct, sql);
      await holder.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
      await sql.end({ timeout: 1 });
      await direct.end({ timeout: 1 });
    }
  }, 15_000);

  // Pin 30
  it("a backup code works once", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin30@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const rawCode = enrolled.backupCodes[0]!;
      const formatted = `${rawCode.slice(0, 4).toLowerCase()}-${rawCode.slice(4, 8)} ${rawCode.slice(8).toLowerCase()}`;

      const sf1 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const first = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf1.accessToken,
        now: t1,
        method: "backup_code",
        code: formatted,
      });
      expect(first.outcome).toBe("verified");
      if (first.outcome === "verified") {
        expect(first.backupCodesLeft).toBe(9);
      }

      const sf2 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sf2.accessToken,
          now: t1,
          method: "backup_code",
          code: rawCode,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // Parallel attempts with the same unused backup code across two pre-2FA sessions grant one admin session
      const sf3 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const sf4 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const secondCode = enrolled.backupCodes[1]!;
      const parallel = await Promise.all([
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sf3.accessToken,
          now: t1,
          method: "backup_code",
          code: secondCode,
        }),
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sf4.accessToken,
          now: t1,
          method: "backup_code",
          code: secondCode,
        }),
      ]);
      expect(parallel.filter((r) => r.outcome === "verified")).toHaveLength(1);
      expect(parallel.filter((r) => r.outcome === "refused")).toHaveLength(1);

      const [unused] = await sql<{ n: number }[]>`
        select count(*)::int as n
        from identity.backup_codes
        where user_id = ${userId} and used_at is null
      `;
      expect(unused?.n).toBe(8);

      const [usedEvents] = await sql<{ n: number }[]>`
        select count(*)::int as n
        from identity.second_factor_events
        where user_id = ${userId} and event = 'backup_code_used'
      `;
      expect(usedEvents?.n).toBe(2);
    });
  });

  // Pin 31
  it("a backup-code sign-in sets a ten-minute recovery window and no fresh factor", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin31@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const verified = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now: t1,
        method: "backup_code",
        code: enrolled.backupCodes[0]!,
      });
      expect(verified.outcome).toBe("verified");
      if (verified.outcome !== "verified") {
        throw new Error("expected verified");
      }
      expect(verified.backupCodesLeft).toBe(9);

      const accessHash = await sessionAccessHash(sql, kms, KEY_ARN, verified.tokens.accessToken);
      const [row] = await sql<
        {
          kind: string;
          factor: string | null;
          fresh_factor_at: Date | null;
          recovery_until: Date | null;
        }[]
      >`
        select kind, factor, fresh_factor_at, recovery_until
        from identity.sessions
        where access_hash = ${accessHash}
      `;
      expect(row?.kind).toBe("tenant");
      expect(row?.factor).toBe("otp_backup_code");
      expect(row?.fresh_factor_at).toBeNull();
      expect(row?.recovery_until).toEqual(new Date(t1.getTime() + TEN_MINUTES_MS));

      const listed = await listSecondFactors(sql, kms, KEY_ARN, {
        accessToken: verified.tokens.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
      });
      expect(listed.outcome).toBe("listed");
      if (listed.outcome === "listed") {
        expect(listed.freshUntil).toBeNull();
        expect(listed.backupCodesLeft).toBe(9);
      }
    });
  });

  // Pin 32
  it("refuses TOTP start from a pre-2FA session when the user has a factor", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      // User with confirmed TOTP
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin32-totp@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const sfTotp = await createSession(sql, kms, KEY_ARN, {
        userId: enrolled.tokens.userId,
        now,
        kind: "second_factor",
      });
      await expect(
        startTotpSetup(sql, kms, KEY_ARN, {
          accessToken: sfTotp.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });
      const [totpRow] = await sql<{ pending_secret: Uint8Array | null }[]>`
        select pending_secret from identity.totp_credentials where user_id = ${enrolled.tokens.userId}
      `;
      expect(totpRow?.pending_secret).toBeNull();

      // User with a counting passkey only (no TOTP row)
      const { userId: passkeyUserId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin32-pk@example.test",
      });
      await insertCountingPasskey(sql, passkeyUserId, ADMIN_RP_ID, now);
      const sfPasskey = await createSession(sql, kms, KEY_ARN, {
        userId: passkeyUserId,
        now,
        kind: "second_factor",
      });
      await expect(
        startTotpSetup(sql, kms, KEY_ARN, {
          accessToken: sfPasskey.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });
      const rows = await sql<{ id: string }[]>`
        select id from identity.totp_credentials where user_id = ${passkeyUserId}
      `;
      expect(rows).toHaveLength(0);
    });
  });

  // Pin 33
  it("refuses TOTP confirm from a pre-2FA session when the user has a factor", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      // Case A: user has confirmed TOTP and a pending_secret started from a fresh tenant session
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin33-a@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const freshTenant = await createSession(sql, kms, KEY_ARN, {
        userId: enrolled.tokens.userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });
      const replacementStarted = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: freshTenant.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      if (replacementStarted.outcome !== "started") {
        throw new Error("expected replacement start");
      }
      const pendingKey = base32Decode(replacementStarted.secret)!;
      const sfA = await createSession(sql, kms, KEY_ARN, {
        userId: enrolled.tokens.userId,
        now,
        kind: "second_factor",
      });
      await expect(
        confirmTotpSetup(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: sfA.accessToken,
            now,
            code: totpCode(pendingKey, stepAt(now)),
            adminRpId: ADMIN_RP_ID,
          },
          { notice: new MemoryNotice() },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      const [credA] = await sql<{ pending_secret: Uint8Array | null }[]>`
        select pending_secret from identity.totp_credentials where user_id = ${enrolled.tokens.userId}
      `;
      expect(credA?.pending_secret).not.toBeNull();

      // Case B: user started TOTP unconfirmed, then got a counting passkey before confirm
      const { userId: userB } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin33-b@example.test",
      });
      const sfB = await createSession(sql, kms, KEY_ARN, {
        userId: userB,
        now,
        kind: "second_factor",
      });
      const startedB = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: sfB.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      if (startedB.outcome !== "started") {
        throw new Error("expected startB");
      }
      const keyB = base32Decode(startedB.secret)!;
      await insertCountingPasskey(sql, userB, ADMIN_RP_ID, now);

      await expect(
        confirmTotpSetup(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: sfB.accessToken,
            now,
            code: totpCode(keyB, stepAt(now)),
            adminRpId: ADMIN_RP_ID,
          },
          { notice: new MemoryNotice() },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      const [credB] = await sql<{ confirmed_at: Date | null }[]>`
        select confirmed_at from identity.totp_credentials where user_id = ${userB}
      `;
      expect(credB?.confirmed_at).toBeNull();
    });
  });

  // Pin 34
  it("an unconfirmed TOTP is not a factor", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin34@example.test",
      });
      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "second_factor",
      });

      const firstStart = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(firstStart.outcome).toBe("started");

      // hasSecondFactor must be false while TOTP is unconfirmed
      const hasFactor = await sql.begin((tx) => hasSecondFactor(tx, userId, ADMIN_RP_ID));
      expect(hasFactor).toBe(false);

      // A tenant session (for a hypothetical check) does not list unconfirmed TOTP
      const tenantView = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "passkey_uv",
      });
      const listed = await listSecondFactors(sql, kms, KEY_ARN, {
        accessToken: tenantView.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(listed.outcome).toBe("listed");
      if (listed.outcome === "listed") {
        expect(listed.totp).toBeNull();
      }

      // Unconfirmed TOTP cannot be used to pass the second step
      if (firstStart.outcome !== "started") {
        throw new Error("expected started");
      }
      const key1 = base32Decode(firstStart.secret)!;
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sf.accessToken,
          now,
          method: "totp",
          code: totpCode(key1, stepAt(now)),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // Pre-2FA caller can still start again and confirm because unconfirmed TOTP is not a factor
      const secondStart = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(secondStart.outcome).toBe("started");
      if (secondStart.outcome !== "started") {
        throw new Error("expected secondStart");
      }
      const key2 = base32Decode(secondStart.secret)!;
      const confirmed = await confirmTotpSetup(
        sql,
        kms,
        KEY_ARN,
        {
          accessToken: sf.accessToken,
          now,
          code: totpCode(key2, stepAt(now)),
          adminRpId: ADMIN_RP_ID,
        },
        { notice: new MemoryNotice() },
      );
      expect(confirmed.outcome).toBe("confirmed");
    });
  });

  // Pin 35
  it("the first setup from a pre-2FA session sets no fresh factor", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin35@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const accessHash = await sessionAccessHash(sql, kms, KEY_ARN, enrolled.tokens.accessToken);
      const [row] = await sql<
        {
          kind: string;
          factor: string | null;
          fresh_factor_at: Date | null;
          recovery_until: Date | null;
        }[]
      >`
        select kind, factor, fresh_factor_at, recovery_until
        from identity.sessions
        where access_hash = ${accessHash}
      `;
      expect(row?.kind).toBe("tenant");
      expect(row?.factor).toBe("otp_totp");
      expect(row?.fresh_factor_at).toBeNull();
      expect(row?.recovery_until).toBeNull();

      const listed = await listSecondFactors(sql, kms, KEY_ARN, {
        accessToken: enrolled.tokens.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(listed.outcome).toBe("listed");
      if (listed.outcome === "listed") {
        expect(listed.freshUntil).toBeNull();
      }

      // Starting TOTP replacement with this session is refused because it has no fresh factor
      await expect(
        startTotpSetup(sql, kms, KEY_ARN, {
          accessToken: enrolled.tokens.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });
    });
  });

  // Pin 36
  it("a wrong code, a wrong backup code and a missing factor give the same error", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin36-with-factor@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const sfWithFactor = await createSession(sql, kms, KEY_ARN, {
        userId: enrolled.tokens.userId,
        now: t1,
        kind: "second_factor",
      });
      const rightCode = totpCode(enrolled.key, stepAt(t1));
      const wrongCode = rightCode === "000000" ? "111111" : "000000";

      const wrongTotpPromise = verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sfWithFactor.accessToken,
        now: t1,
        method: "totp",
        code: wrongCode,
      });
      await expect(wrongTotpPromise).resolves.toEqual({ outcome: "refused" });

      const wrongBackupPromise = verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sfWithFactor.accessToken,
        now: t1,
        method: "backup_code",
        code: "AAAAAAAAAAAA",
      });
      await expect(wrongBackupPromise).resolves.toEqual({ outcome: "refused" });

      const { userId: noFactorUserId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin36-missing@example.test",
      });
      const sfMissing = await createSession(sql, kms, KEY_ARN, {
        userId: noFactorUserId,
        now: t1,
        kind: "second_factor",
      });

      const missingTotpPromise = verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sfMissing.accessToken,
        now: t1,
        method: "totp",
        code: "123456",
      });
      await expect(missingTotpPromise).resolves.toEqual({ outcome: "refused" });

      const missingBackupPromise = verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sfMissing.accessToken,
        now: t1,
        method: "backup_code",
        code: "BBBBBBBBBBBB",
      });
      await expect(missingBackupPromise).resolves.toEqual({ outcome: "refused" });
    });
  });

  // Pin 37
  it("stores the TOTP secret encrypted", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin37@example.test",
      });
      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "second_factor",
      });
      const started = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(started.outcome).toBe("started");
      if (started.outcome !== "started") {
        throw new Error("expected started");
      }
      const key = base32Decode(started.secret)!;
      const [row] = await sql<{ id: string; secret: Uint8Array }[]>`
        select id, secret from identity.totp_credentials where user_id = ${userId}
      `;
      expect(row).toBeDefined();
      expect(Buffer.from(row!.secret).equals(Buffer.from(key))).toBe(false);
      expect(row!.secret.byteLength).toBeGreaterThan(key.byteLength);

      const keys = await deriveIdentityEmailKeys(sql, kms, KEY_ARN);
      const plaintext = await decrypt(row!.secret as never, () => keys.enc, {
        tag: "chub/field-identity/v1",
        label: "identity.totp_secret",
        rowId: uuidToBytes(row!.id),
        region: "au",
      });
      expect(Buffer.from(plaintext)).toEqual(Buffer.from(key));
    });
  });

  // Pin 38
  it("a pending secret does not decrypt as the secret", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin38@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const freshTenant = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });
      const started = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: freshTenant.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(started.outcome).toBe("started");
      if (started.outcome !== "started") {
        throw new Error("expected started");
      }
      const pendingKey = base32Decode(started.secret)!;
      const [row] = await sql<{ id: string; pending_secret: Uint8Array | null }[]>`
        select id, pending_secret from identity.totp_credentials where user_id = ${userId}
      `;
      expect(row?.pending_secret).not.toBeNull();

      const keys = await deriveIdentityEmailKeys(sql, kms, KEY_ARN);
      await expect(
        decrypt(row!.pending_secret as never, () => keys.enc, {
          tag: "chub/field-identity/v1",
          label: "identity.totp_secret",
          rowId: uuidToBytes(row!.id),
          region: "au",
        }),
      ).rejects.toMatchObject({ name: "OperationError" });

      const decryptedPending = await decrypt(row!.pending_secret as never, () => keys.enc, {
        tag: "chub/field-identity/v1",
        label: "identity.totp_pending_secret",
        rowId: uuidToBytes(row!.id),
        region: "au",
      });
      expect(Buffer.from(decryptedPending)).toEqual(Buffer.from(pendingKey));

      // Confirming replacement moves it into secret under identity.totp_secret and clears pending_secret
      const confirmed = await confirmTotpSetup(
        sql,
        kms,
        KEY_ARN,
        {
          accessToken: freshTenant.accessToken,
          now,
          code: totpCode(pendingKey, stepAt(now)),
          adminRpId: ADMIN_RP_ID,
        },
        { notice: new MemoryNotice() },
      );
      expect(confirmed).toEqual({ outcome: "confirmed" });

      const [after] = await sql<
        { id: string; secret: Uint8Array; pending_secret: Uint8Array | null }[]
      >`
        select id, secret, pending_secret from identity.totp_credentials where user_id = ${userId}
      `;
      expect(after?.pending_secret).toBeNull();
      const decryptedSecret = await decrypt(after!.secret as never, () => keys.enc, {
        tag: "chub/field-identity/v1",
        label: "identity.totp_secret",
        rowId: uuidToBytes(after!.id),
        region: "au",
      });
      expect(Buffer.from(decryptedSecret)).toEqual(Buffer.from(pendingKey));
    });
  });

  // Pin 39
  it("TOTP confirm waits for the second factor lock", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
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
    let confirmPromise: ReturnType<typeof confirmTotpSetup> | undefined;

    try {
      await clearIdentity(direct, sql);
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin39-lock@example.test",
      });
      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "second_factor",
      });
      const started = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      if (started.outcome !== "started") {
        throw new Error("expected started");
      }
      const key = base32Decode(started.secret)!;

      holderPromise = holder.begin(async (tx) => {
        const pidRows = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        holderPid = pidRows[0]!.pid;
        await lockSecondFactor(tx, userId);
        lockAcquiredNotify();
        await holderGate;
      });
      await Promise.race([lockAcquired, holderPromise]);

      confirmPromise = confirmTotpSetup(
        sql,
        kms,
        KEY_ARN,
        {
          accessToken: sf.accessToken,
          now,
          code: totpCode(key, stepAt(now)),
          adminRpId: ADMIN_RP_ID,
        },
        { notice: new MemoryNotice() },
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
      const confirmResult = await confirmPromise;
      expect(settled).toBe(true);
      expect(confirmResult.outcome).toBe("confirmed");

      // Also asserts two first setups from two pre-2FA sessions give one factor
      const { userId: raceUserId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin39-race@example.test",
      });
      const sf1 = await createSession(sql, kms, KEY_ARN, {
        userId: raceUserId,
        now,
        kind: "second_factor",
      });
      const sf2 = await createSession(sql, kms, KEY_ARN, {
        userId: raceUserId,
        now,
        kind: "second_factor",
      });
      const started2 = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: sf2.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      if (started2.outcome !== "started") {
        throw new Error("expected started2");
      }
      const raceKey = base32Decode(started2.secret)!;
      const raceCode = totpCode(raceKey, stepAt(now));

      const raceNotice = new MemoryNotice();
      const raceResults = await Promise.all([
        confirmTotpSetup(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: sf1.accessToken,
            now,
            code: raceCode,
            adminRpId: ADMIN_RP_ID,
          },
          { notice: raceNotice },
        ),
        confirmTotpSetup(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: sf2.accessToken,
            now,
            code: raceCode,
            adminRpId: ADMIN_RP_ID,
          },
          { notice: raceNotice },
        ),
      ]);
      expect(raceResults.filter((r) => r.outcome === "confirmed")).toHaveLength(1);
      expect(raceResults.filter((r) => r.outcome === "refused")).toHaveLength(1);

      const [credCount] = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.totp_credentials where user_id = ${raceUserId} and confirmed_at is not null
      `;
      const [codeCount] = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.backup_codes where user_id = ${raceUserId}
      `;
      const [sessionCount] = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.sessions where user_id = ${raceUserId} and kind = 'tenant'
      `;
      expect(credCount?.n).toBe(1);
      expect(codeCount?.n).toBe(10);
      expect(sessionCount?.n).toBe(1);
    } finally {
      releaseHolder();
      await confirmPromise?.catch(() => undefined);
      await holderPromise?.catch(() => undefined);
      await clearIdentity(direct, sql);
      await holder.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
      await sql.end({ timeout: 1 });
      await direct.end({ timeout: 1 });
    }
  }, 15_000);

  // Pin 40
  it("a pre-2FA session cannot take an unused backup code after its second step", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin40@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;
      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const verified = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now: t1,
        method: "totp",
        code: totpCode(enrolled.key, stepAt(t1)),
      });
      expect(verified.outcome).toBe("verified");

      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sf.accessToken,
          now: t1,
          method: "backup_code",
          code: enrolled.backupCodes[0]!,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      const [unused] = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.backup_codes where user_id = ${userId} and used_at is null
      `;
      expect(unused?.n).toBe(10);

      const [tenantCount] = await sql<{ n: number }[]>`
        select count(*)::int as n
        from identity.sessions
        where user_id = ${userId} and kind = 'tenant' and revoked_at is null
      `;
      expect(tenantCount?.n).toBe(2); // 1 from enrol + 1 from TOTP second step
    });
  });

  // Pin 41
  it("the second step records the factor on the admin session", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin41@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;

      // TOTP second step -> factor = 'otp_totp', fresh_factor_at = t1
      const sfTotp = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const totpRes = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sfTotp.accessToken,
        now: t1,
        method: "totp",
        code: totpCode(enrolled.key, stepAt(t1)),
      });
      expect(totpRes.outcome).toBe("verified");
      if (totpRes.outcome !== "verified") {
        throw new Error("expected verified");
      }
      expect(totpRes.backupCodesLeft).toBeUndefined();

      const totpHash = await sessionAccessHash(sql, kms, KEY_ARN, totpRes.tokens.accessToken);
      const [totpRow] = await sql<
        { factor: string | null; fresh_factor_at: Date | null; recovery_until: Date | null }[]
      >`
        select factor, fresh_factor_at, recovery_until
        from identity.sessions
        where access_hash = ${totpHash}
      `;
      expect(totpRow?.factor).toBe("otp_totp");
      expect(totpRow?.fresh_factor_at).toEqual(t1);
      expect(totpRow?.recovery_until).toBeNull();

      // Refresh carries the recorded factor
      const refreshed = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: totpRes.tokens.refreshToken,
        now: t1,
      });
      expect(refreshed).not.toBeNull();
      const refHash = await sessionAccessHash(sql, kms, KEY_ARN, refreshed!.accessToken);
      const [refRow] = await sql<{ factor: string | null }[]>`
        select factor from identity.sessions where access_hash = ${refHash}
      `;
      expect(refRow?.factor).toBe("otp_totp");

      // Backup code second step -> factor = 'otp_backup_code'
      const sfBackup = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const backupRes = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sfBackup.accessToken,
        now: t1,
        method: "backup_code",
        code: enrolled.backupCodes[0]!,
      });
      expect(backupRes.outcome).toBe("verified");
      if (backupRes.outcome !== "verified") {
        throw new Error("expected verified");
      }
      const backupHash = await sessionAccessHash(sql, kms, KEY_ARN, backupRes.tokens.accessToken);
      const [backupRow] = await sql<{ factor: string | null }[]>`
        select factor from identity.sessions where access_hash = ${backupHash}
      `;
      expect(backupRow?.factor).toBe("otp_backup_code");
    });
  });

  // Pin 42
  it("the factor list never returns a TOTP secret", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin42@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;

      const freshTenant = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: now,
      });
      // Also create a pending replacement secret
      const pending = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: freshTenant.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(pending.outcome).toBe("started");
      if (pending.outcome !== "started") {
        throw new Error("expected pending start");
      }

      // Add one counting passkey and three non-counting passkeys
      const countingPkId = await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      await sql`
        insert into identity.passkey_credentials (
          id, user_id, credential_id, cose_key, sign_count, rp_id, user_verified, created_at
        ) values
          (${newId()}, ${userId}, ${crypto.getRandomValues(new Uint8Array(32))}, ${crypto.getRandomValues(new Uint8Array(32))}, 0, ${ADMIN_RP_ID}, false, ${now}),
          (${newId()}, ${userId}, ${crypto.getRandomValues(new Uint8Array(32))}, ${crypto.getRandomValues(new Uint8Array(32))}, 0, ${null}, true, ${now}),
          (${newId()}, ${userId}, ${crypto.getRandomValues(new Uint8Array(32))}, ${crypto.getRandomValues(new Uint8Array(32))}, 0, ${"ops.example.test"}, true, ${now})
      `;

      const listed = await listSecondFactors(sql, kms, KEY_ARN, {
        accessToken: freshTenant.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(listed.outcome).toBe("listed");
      if (listed.outcome !== "listed") {
        throw new Error("expected listed");
      }

      expect(listed.totp).toEqual({ confirmedAt: now });
      expect(Object.keys(listed.totp ?? {})).toEqual(["confirmedAt"]);
      expect("secret" in listed).toBe(false);
      expect("pendingSecret" in listed).toBe(false);
      expect(JSON.stringify(listed)).not.toContain(base32Encode(enrolled.key));
      expect(JSON.stringify(listed)).not.toContain(pending.secret);

      expect(listed.passkeys).toEqual([{ id: countingPkId, createdAt: now }]);
      expect(listed.backupCodesLeft).toBe(10);
      expect(listed.freshUntil).toEqual(new Date(now.getTime() + FIVE_MINUTES_MS));

      // Fresh window expires after 5 minutes
      const stale = await listSecondFactors(sql, kms, KEY_ARN, {
        accessToken: freshTenant.accessToken,
        now: new Date(now.getTime() + FIVE_MINUTES_MS + 1),
        adminRpId: ADMIN_RP_ID,
      });
      expect(stale.outcome).toBe("listed");
      if (stale.outcome === "listed") {
        expect(stale.freshUntil).toBeNull();
      }
    });
  });

  // Pin 109
  it("a pre-2FA session cannot set up TOTP for a passkey-only user when no rp id is passed", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      // Case A: passkey-only user with no TOTP row
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin109-a@example.test",
      });
      await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "second_factor",
      });
      const notice = new MemoryNotice();

      await expect(
        startTotpSetup(sql, kms, KEY_ARN, {
          accessToken: sf.accessToken,
          now,
          adminRpId: null,
        }).then((result) => result.outcome),
      ).resolves.toBe("refused");

      await expect(
        confirmTotpSetup(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: sf.accessToken,
            now,
            code: "000000",
            adminRpId: null,
          },
          { notice },
        ).then((result) => result.outcome),
      ).resolves.toBe("refused");

      const rowsA = await sql<{ id: string }[]>`
        select id from identity.totp_credentials where user_id = ${userId}
      `;
      expect(rowsA).toHaveLength(0);

      // Case B: user started TOTP before enrolling a counting passkey, then attempts confirm with adminRpId: null
      const { userId: userB } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin109-b@example.test",
      });
      const sfB = await createSession(sql, kms, KEY_ARN, {
        userId: userB,
        now,
        kind: "second_factor",
      });
      const startedB = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: sfB.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      if (startedB.outcome !== "started") {
        throw new Error("expected startedB");
      }
      const keyB = base32Decode(startedB.secret)!;
      await insertCountingPasskey(sql, userB, ADMIN_RP_ID, now);

      await expect(
        confirmTotpSetup(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: sfB.accessToken,
            now,
            code: totpCode(keyB, stepAt(now)),
            adminRpId: null,
          },
          { notice },
        ).then((result) => result.outcome),
      ).resolves.toBe("refused");

      const [credB] = await sql<{ confirmed_at: Date | null }[]>`
        select confirmed_at from identity.totp_credentials where user_id = ${userB}
      `;
      expect(credB?.confirmed_at).toBeNull();

      const [tenantCount] = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.sessions where user_id = ${userB} and kind = 'tenant'
      `;
      expect(tenantCount?.n).toBe(0);
      expect(notice.calls).toHaveLength(0);
    });
  });

  // Coverage tests: success paths, RFC vectors, limits under concurrency, replacement, and caller rules
  it("accepts a TOTP second step within one step either side and refuses two steps away", async () => {
    const baseTime = new Date(1234567890 * 1000);
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "rfc-window@example.test",
      });
      const keys = await deriveIdentityEmailKeys(sql, kms, KEY_ARN);
      const credId = newId();
      const ciphertext: Uint8Array = await encrypt(
        keys.enc,
        RFC_6238_KEY,
        uuidToBytes(keys.keyId),
        {
          tag: "chub/field-identity/v1",
          label: "identity.totp_secret",
          rowId: uuidToBytes(credId),
          region: "au",
        },
      );
      await sql`
        insert into identity.totp_credentials (id, user_id, secret, confirmed_at, created_at)
        values (${credId}, ${userId}, ${ciphertext}, ${baseTime}, ${baseTime})
      `;

      const step = stepAt(baseTime);
      const sfTwoAway = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: baseTime,
        kind: "second_factor",
      });
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sfTwoAway.accessToken,
          now: baseTime,
          method: "totp",
          code: totpCode(RFC_6238_KEY, step - 2),
        }),
      ).resolves.toEqual({ outcome: "refused" });
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sfTwoAway.accessToken,
          now: baseTime,
          method: "totp",
          code: totpCode(RFC_6238_KEY, step + 2),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // t - 1 succeeds
      const sfPrev = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: baseTime,
        kind: "second_factor",
      });
      const prevRes = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sfPrev.accessToken,
        now: baseTime,
        method: "totp",
        code: totpCode(RFC_6238_KEY, step - 1),
      });
      expect(prevRes.outcome).toBe("verified");

      // t + 1 succeeds
      const sfNext = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: baseTime,
        kind: "second_factor",
      });
      const nextRes = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sfNext.accessToken,
        now: baseTime,
        method: "totp",
        code: totpCode(RFC_6238_KEY, step + 1),
      });
      expect(nextRes.outcome).toBe("verified");
    });
  });

  it("twenty parallel wrong answers on one pre-2FA session count at most five", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(
      async (sql) => {
        const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
          email: "parallel-20@example.test",
          now,
          adminRpId: ADMIN_RP_ID,
        });
        const userId = enrolled.tokens.userId;
        const sf = await createSession(sql, kms, KEY_ARN, {
          userId,
          now: t1,
          kind: "second_factor",
        });
        const sfHash = await sessionAccessHash(sql, kms, KEY_ARN, sf.accessToken);
        const rightCode = totpCode(enrolled.key, stepAt(t1));
        const wrongCode = rightCode === "000000" ? "111111" : "000000";

        const results = await Promise.all(
          Array.from({ length: 20 }, () =>
            verifySecondStep(sql, kms, KEY_ARN, {
              accessToken: sf.accessToken,
              now: t1,
              method: "totp",
              code: wrongCode,
            }),
          ),
        );
        expect(results.every((r) => r.outcome === "refused")).toBe(true);

        const [sfRow] = await sql<{ second_factor_attempts: number; revoked_at: Date | null }[]>`
          select second_factor_attempts, revoked_at
          from identity.sessions
          where access_hash = ${sfHash}
        `;
        expect(sfRow?.second_factor_attempts).toBe(5);
        expect(sfRow?.revoked_at).toEqual(t1);

        const [events] = await sql<{ n: number }[]>`
          select count(*)::int as n
          from identity.second_factor_events
          where user_id = ${userId} and event = 'verify_failed'
        `;
        expect(events?.n).toBe(5);
      },
      { max: 25 },
    );
  });

  it("replaces TOTP from a fresh tenant session, ends other tenant and pre-2FA sessions, and keeps operator and enrolment sessions", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "replace-totp@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;

      const currentTenant = await createSession(sql, kms, KEY_ARN, {
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

      const firstPending = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: currentTenant.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
      });
      expect(firstPending.outcome).toBe("started");
      if (firstPending.outcome !== "started") {
        throw new Error("expected started");
      }
      expect(firstPending.otpauthUri).toBe(
        `otpauth://totp/Community%20Hub?secret=${firstPending.secret}&issuer=Community%20Hub&algorithm=SHA1&digits=6&period=30`,
      );

      // Starting again replaces pending_secret and invalidates the earlier pending key
      const secondPending = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: currentTenant.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
      });
      expect(secondPending.outcome).toBe("started");
      if (secondPending.outcome !== "started") {
        throw new Error("expected secondPending");
      }
      const firstPendingKey = base32Decode(firstPending.secret)!;
      const secondPendingKey = base32Decode(secondPending.secret)!;

      const replaceNotice = new MemoryNotice();
      await expect(
        confirmTotpSetup(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: currentTenant.accessToken,
            now: t1,
            code: totpCode(firstPendingKey, stepAt(t1)),
            adminRpId: ADMIN_RP_ID,
          },
          { notice: replaceNotice },
        ),
      ).resolves.toEqual({ outcome: "refused" });

      const confirmed = await confirmTotpSetup(
        sql,
        kms,
        KEY_ARN,
        {
          accessToken: currentTenant.accessToken,
          now: t1,
          code: totpCode(secondPendingKey, stepAt(t1)),
          adminRpId: ADMIN_RP_ID,
        },
        { notice: replaceNotice },
      );
      expect(confirmed).toEqual({ outcome: "confirmed" });

      // Current tenant session remains valid, other tenant/second_factor sessions are revoked, operator/enrolment untouched
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: currentTenant.accessToken,
          now: t1,
          kinds: ["tenant"],
        }),
      ).toEqual({ userId, kind: "tenant" });
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: otherTenant.accessToken,
          now: t1,
          kinds: ["tenant"],
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

      // Old TOTP key no longer verifies; new TOTP key verifies at the next step
      const t2 = new Date(t1.getTime() + 30_000);
      const sfOld = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t2,
        kind: "second_factor",
      });
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sfOld.accessToken,
          now: t2,
          method: "totp",
          code: totpCode(enrolled.key, stepAt(t2)),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      const sfNew = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t2,
        kind: "second_factor",
      });
      const verifiedNew = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sfNew.accessToken,
        now: t2,
        method: "totp",
        code: totpCode(secondPendingKey, stepAt(t2)),
      });
      expect(verifiedNew.outcome).toBe("verified");
    });
  });

  it("allows TOTP replacement within a backup-code recovery window and refuses stale or expired sessions", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "recovery-totp@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;

      const sf = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const backupSignIn = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now: t1,
        method: "backup_code",
        code: enrolled.backupCodes[0]!,
      });
      expect(backupSignIn.outcome).toBe("verified");
      if (backupSignIn.outcome !== "verified") {
        throw new Error("expected backupSignIn");
      }

      // Expired recovery window is refused
      const afterRecovery = new Date(t1.getTime() + TEN_MINUTES_MS);
      await expect(
        startTotpSetup(sql, kms, KEY_ARN, {
          accessToken: backupSignIn.tokens.accessToken,
          now: afterRecovery,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // Within recovery window (< 10 min) TOTP replacement succeeds
      const inRecovery = new Date(t1.getTime() + TEN_MINUTES_MS - 1);
      const started = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: backupSignIn.tokens.accessToken,
        now: inRecovery,
        adminRpId: ADMIN_RP_ID,
      });
      expect(started.outcome).toBe("started");
      if (started.outcome !== "started") {
        throw new Error("expected started");
      }
      const newKey = base32Decode(started.secret)!;
      await expect(
        confirmTotpSetup(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: backupSignIn.tokens.accessToken,
            now: inRecovery,
            code: totpCode(newKey, stepAt(inRecovery)),
            adminRpId: ADMIN_RP_ID,
          },
          { notice: new MemoryNotice() },
        ),
      ).resolves.toEqual({ outcome: "confirmed" });

      // Fresh tenant session expires after 5 minutes
      const freshSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: t1,
      });
      await expect(
        startTotpSetup(sql, kms, KEY_ARN, {
          accessToken: freshSession.accessToken,
          now: new Date(t1.getTime() + FIVE_MINUTES_MS + 1),
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // Expired, revoked, unknown, malformed, and wrong-kind sessions are refused across all functions
      const opSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "operator",
        absoluteExpiresAt: new Date(t1.getTime() + HOUR_MS),
      });
      const tenantSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "otp_totp",
      });
      const sfActive = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const sfExpiredTime = new Date(t1.getTime() + 15 * 60 * 1000);

      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: tenantSession.accessToken,
          now: t1,
          method: "totp",
          code: totpCode(newKey, stepAt(t1)),
        }),
      ).resolves.toEqual({ outcome: "refused" });
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: opSession.accessToken,
          now: t1,
          method: "totp",
          code: totpCode(newKey, stepAt(t1)),
        }),
      ).resolves.toEqual({ outcome: "refused" });
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sfActive.accessToken,
          now: sfExpiredTime,
          method: "totp",
          code: totpCode(newKey, stepAt(sfExpiredTime)),
        }),
      ).resolves.toEqual({ outcome: "refused" });
      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: "not-a-valid-token",
          now: t1,
          method: "totp",
          code: "000000",
        }),
      ).resolves.toEqual({ outcome: "refused" });
      await expect(
        listSecondFactors(sql, kms, KEY_ARN, {
          accessToken: sfActive.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });
      await expect(
        listSecondFactors(sql, kms, KEY_ARN, {
          accessToken: opSession.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });
      await expect(
        startTotpSetup(sql, kms, KEY_ARN, {
          accessToken: opSession.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });
      await expect(
        confirmTotpSetup(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: opSession.accessToken,
            now: t1,
            code: "000000",
            adminRpId: ADMIN_RP_ID,
          },
          { notice: new MemoryNotice() },
        ),
      ).resolves.toEqual({ outcome: "refused" });
      // Confirming without start returns refused
      const { userId: noSetupUser } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "no-setup@example.test",
      });
      const sfNoSetup = await createSession(sql, kms, KEY_ARN, {
        userId: noSetupUser,
        now: t1,
        kind: "second_factor",
      });
      await expect(
        confirmTotpSetup(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: sfNoSetup.accessToken,
            now: t1,
            code: totpCode(newTotpKey(), stepAt(t1)),
            adminRpId: ADMIN_RP_ID,
          },
          { notice: new MemoryNotice() },
        ),
      ).resolves.toEqual({ outcome: "refused" });
    });
  });

  it("allows a fresh tenant session with an existing passkey to add TOTP without duplicating backup codes", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "passkey-adds-totp@example.test",
      });
      await insertCountingPasskey(sql, userId, ADMIN_RP_ID, now);
      const freshTenant = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "passkey_uv",
        freshFactorAt: now,
      });

      const started = await startTotpSetup(sql, kms, KEY_ARN, {
        accessToken: freshTenant.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(started.outcome).toBe("started");
      if (started.outcome !== "started") {
        throw new Error("expected started");
      }
      const key = base32Decode(started.secret)!;
      const confirmed = await confirmTotpSetup(
        sql,
        kms,
        KEY_ARN,
        {
          accessToken: freshTenant.accessToken,
          now,
          code: totpCode(key, stepAt(now)),
          adminRpId: ADMIN_RP_ID,
        },
        { notice: new MemoryNotice() },
      );
      expect(confirmed).toEqual({ outcome: "confirmed" });

      const [backupCount] = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.backup_codes where user_id = ${userId}
      `;
      expect(backupCount?.n).toBe(0);

      const events = await sql<{ event: string }[]>`
        select event from identity.second_factor_events where user_id = ${userId}
      `;
      expect(events.map((e) => e.event)).toEqual(["totp_enrolled"]);
    });
  });

  // Pin 7
  it("seven correct TOTP fresh checks in one session all answer fresh", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin7-fresh-totp@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const accessHash = await sessionAccessHash(sql, kms, KEY_ARN, enrolled.tokens.accessToken);

      for (let i = 1; i <= 7; i += 1) {
        const t = new Date(now.getTime() + i * 30_000);
        const code = totpCode(enrolled.key, stepAt(t));
        await expect(
          freshCheckTotp(sql, kms, KEY_ARN, {
            accessToken: enrolled.tokens.accessToken,
            now: t,
            code,
          }),
        ).resolves.toEqual({ outcome: "fresh" });
      }

      const [row] = await sql<{ second_factor_attempts: number }[]>`
        select second_factor_attempts from identity.sessions where access_hash = ${accessHash}
      `;
      expect(row?.second_factor_attempts).toBe(0);
    });
  });

  // Pin 8
  it("seven correct passkey fresh checks in one session all answer fresh", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin8-fresh-pk@example.test",
      });
      const enrolled = await registerTenantPasskeyForTest(sql, kms, userId, now);
      const accessHash = await sessionAccessHash(sql, kms, KEY_ARN, enrolled.tokens.accessToken);

      for (let i = 1; i <= 7; i += 1) {
        const t = new Date(now.getTime() + i * 30_000);
        const opts = await beginFreshPasskey(sql, kms, KEY_ARN, {
          accessToken: enrolled.tokens.accessToken,
          now: t,
          adminRpId: ADMIN_RP_ID,
        });
        expect(opts.outcome).toBe("started");
        if (opts.outcome !== "started") {
          throw new Error("expected started");
        }
        const authData = authenticatorDataBytes({
          rpId: ADMIN_RP_ID,
          signCount: i,
          flags: 0x05,
        });
        const client = clientDataBytes("webauthn.get", opts.options.challenge, ADMIN_ORIGIN);
        const signature = await enrolled.key.sign(
          concatBytes([authData, await sha256Bytes(client)]),
        );
        await expect(
          verifyFreshPasskey(sql, kms, KEY_ARN, {
            accessToken: enrolled.tokens.accessToken,
            now: t,
            adminRpId: ADMIN_RP_ID,
            credentialId: enrolled.credentialId,
            clientDataJSON: client,
            authenticatorData: authData,
            signature,
          }),
        ).resolves.toEqual({ outcome: "fresh" });
      }

      const [row] = await sql<{ second_factor_attempts: number }[]>`
        select second_factor_attempts from identity.sessions where access_hash = ${accessHash}
      `;
      expect(row?.second_factor_attempts).toBe(0);
    });
  });

  // Pin 9
  it("five wrong TOTP fresh checks, then a correct one, answers limited", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin9-wrong-count@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const accessHash = await sessionAccessHash(sql, kms, KEY_ARN, enrolled.tokens.accessToken);
      const rightCode = totpCode(enrolled.key, stepAt(t1));
      const wrongCode = rightCode === "000000" ? "111111" : "000000";

      for (let i = 0; i < 5; i += 1) {
        await expect(
          freshCheckTotp(sql, kms, KEY_ARN, {
            accessToken: enrolled.tokens.accessToken,
            now: t1,
            code: wrongCode,
          }),
        ).resolves.toEqual({ outcome: "refused" });
      }

      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: enrolled.tokens.accessToken,
          now: t1,
          code: rightCode,
        }),
      ).resolves.toEqual({ outcome: "limited" });

      const [row] = await sql<{ second_factor_attempts: number; revoked_at: Date | null }[]>`
        select second_factor_attempts, revoked_at
        from identity.sessions
        where access_hash = ${accessHash}
      `;
      expect(row?.second_factor_attempts).toBe(5);
      expect(row?.revoked_at).toBeNull();
    });
  });

  // Pin 11
  it("ten wrong fresh codes across sessions in an hour, then a correct one, answers limited", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    const t2 = new Date(t1.getTime() + 30_000);
    const t3 = new Date(t2.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin11-hourly@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;

      const admin1 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "otp_totp",
      });
      const right1 = totpCode(enrolled.key, stepAt(t1));
      const wrong1 = right1 === "000000" ? "111111" : "000000";
      for (let i = 0; i < 5; i += 1) {
        await expect(
          freshCheckTotp(sql, kms, KEY_ARN, {
            accessToken: admin1.accessToken,
            now: t1,
            code: wrong1,
          }),
        ).resolves.toEqual({ outcome: "refused" });
      }

      const admin2 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t2,
        kind: "tenant",
        factor: "otp_totp",
      });
      const right2 = totpCode(enrolled.key, stepAt(t2));
      const wrong2 = right2 === "000000" ? "111111" : "000000";
      for (let i = 0; i < 5; i += 1) {
        await expect(
          freshCheckTotp(sql, kms, KEY_ARN, {
            accessToken: admin2.accessToken,
            now: t2,
            code: wrong2,
          }),
        ).resolves.toEqual({ outcome: "refused" });
      }

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
    });
  });

  // Pin 12
  it("after one refused and one correct second step, second_factor_attempts is 2", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin12-step@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const sf = await createSession(sql, kms, KEY_ARN, {
        userId: enrolled.tokens.userId,
        now: t1,
        kind: "second_factor",
      });
      const sfHash = await sessionAccessHash(sql, kms, KEY_ARN, sf.accessToken);
      const rightCode = totpCode(enrolled.key, stepAt(t1));
      const wrongCode = rightCode === "000000" ? "111111" : "000000";

      await expect(
        verifySecondStep(sql, kms, KEY_ARN, {
          accessToken: sf.accessToken,
          now: t1,
          method: "totp",
          code: wrongCode,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      const verified = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now: t1,
        method: "totp",
        code: rightCode,
      });
      expect(verified.outcome).toBe("verified");

      const [sfRow] = await sql<{ second_factor_attempts: number }[]>`
        select second_factor_attempts from identity.sessions where access_hash = ${sfHash}
      `;
      expect(sfRow?.second_factor_attempts).toBe(2);
    });
  });

  // Pin 120
  it("a recovery session answers refused to a correct TOTP fresh check and stays without a fresh factor", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    const t2 = new Date(t1.getTime() + 30_000);
    // After the ten-minute window, and still inside the 15-minute life of the access token.
    const t3 = new Date(t1.getTime() + TEN_MINUTES_MS + 30_000);
    await withSql(async (sql) => {
      const enrolled = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "pin120-recovery-totp@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const userId = enrolled.tokens.userId;

      // A real backup-code sign-in opens the recovery session.
      const sf = await createSession(sql, kms, KEY_ARN, { userId, now: t1, kind: "second_factor" });
      const recovery = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now: t1,
        method: "backup_code",
        code: enrolled.backupCodes[0]!,
      });
      if (recovery.outcome !== "verified") {
        throw new Error("expected a backup-code sign-in");
      }
      const recoveryHash = await sessionAccessHash(sql, kms, KEY_ARN, recovery.tokens.accessToken);
      const readRecovery = async () => {
        const [row] = await sql<
          { factor: string | null; fresh_factor_at: Date | null; recovery_until: Date | null }[]
        >`
          select factor, fresh_factor_at, recovery_until
          from identity.sessions
          where access_hash = ${recoveryHash}
        `;
        return row;
      };
      const before = await readRecovery();
      expect(before?.factor).toBe("otp_backup_code");
      expect(before?.fresh_factor_at).toBeNull();
      expect(before?.recovery_until).toEqual(new Date(t1.getTime() + TEN_MINUTES_MS));

      // A correct code, inside the recovery window, is refused.
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: recovery.tokens.accessToken,
          now: t2,
          code: totpCode(enrolled.key, stepAt(t2)),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // Control: the same code from the user's ordinary tenant session is fresh, so the code was
      // right and the recovery session is the only thing wrong with the check above.
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: enrolled.tokens.accessToken,
          now: t2,
          code: totpCode(enrolled.key, stepAt(t2)),
        }),
      ).resolves.toEqual({ outcome: "fresh" });

      // After the window has ended, recovery_until stays set and the session still never passes.
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: recovery.tokens.accessToken,
          now: t3,
          code: totpCode(enrolled.key, stepAt(t3)),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      expect((await readRecovery())?.fresh_factor_at).toBeNull();
    });
  });

  // Pin 121
  it("a recovery session answers refused to a correct passkey fresh check and stays without a fresh factor", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    const t2 = new Date(t1.getTime() + 30_000);
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin121-recovery-pk@example.test",
      });
      const enrolled = await registerTenantPasskeyForTest(sql, kms, userId, now);

      // A real backup-code sign-in opens the recovery session.
      const sf = await createSession(sql, kms, KEY_ARN, { userId, now: t1, kind: "second_factor" });
      const recovery = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now: t1,
        method: "backup_code",
        code: enrolled.backupCodes[0]!,
      });
      if (recovery.outcome !== "verified") {
        throw new Error("expected a backup-code sign-in");
      }
      const recoveryHash = await sessionAccessHash(sql, kms, KEY_ARN, recovery.tokens.accessToken);
      const readRecovery = async () => {
        const [row] = await sql<
          { factor: string | null; fresh_factor_at: Date | null; recovery_until: Date | null }[]
        >`
          select factor, fresh_factor_at, recovery_until
          from identity.sessions
          where access_hash = ${recoveryHash}
        `;
        return row;
      };
      const before = await readRecovery();
      expect(before?.factor).toBe("otp_backup_code");
      expect(before?.fresh_factor_at).toBeNull();
      expect(before?.recovery_until).toEqual(new Date(t1.getTime() + TEN_MINUTES_MS));

      // The recovery session cannot ask for a challenge, but a challenge belongs to the user and
      // not to a session. The user's ordinary session asks for one, and the recovery session
      // answers it with a valid user-verified assertion.
      const opts = await beginFreshPasskey(sql, kms, KEY_ARN, {
        accessToken: enrolled.tokens.accessToken,
        now: t2,
        adminRpId: ADMIN_RP_ID,
      });
      if (opts.outcome !== "started") {
        throw new Error("expected started");
      }
      const authData = authenticatorDataBytes({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const client = clientDataBytes("webauthn.get", opts.options.challenge, ADMIN_ORIGIN);
      const assertion = {
        adminRpId: ADMIN_RP_ID,
        credentialId: enrolled.credentialId,
        clientDataJSON: client,
        authenticatorData: authData,
        signature: await enrolled.key.sign(concatBytes([authData, await sha256Bytes(client)])),
      };

      await expect(
        verifyFreshPasskey(sql, kms, KEY_ARN, {
          accessToken: recovery.tokens.accessToken,
          now: t2,
          ...assertion,
        }),
      ).resolves.toEqual({ outcome: "refused" });
      expect((await readRecovery())?.fresh_factor_at).toBeNull();

      // Control: the same assertion answered by the user's ordinary tenant session is fresh, so
      // the assertion was valid and the recovery session is the only thing wrong with the answer
      // above. The refusal also left the challenge unused.
      await expect(
        verifyFreshPasskey(sql, kms, KEY_ARN, {
          accessToken: enrolled.tokens.accessToken,
          now: t2,
          ...assertion,
        }),
      ).resolves.toEqual({ outcome: "fresh" });
    });
  });

  // Tests-only floor check
  it("second_factor_attempts stays at zero after a correct fresh check", async () => {
    const now = new Date("2026-11-28T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    const t2 = new Date(t1.getTime() + 30_000);
    await withSql(async (sql) => {
      const enrolledTotp = await enrolTotpForTest(sql, kms, KEY_ARN, {
        email: "floor-totp@example.test",
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const totpHash = await sessionAccessHash(sql, kms, KEY_ARN, enrolledTotp.tokens.accessToken);

      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: enrolledTotp.tokens.accessToken,
          now: t1,
          code: totpCode(enrolledTotp.key, stepAt(t1)),
        }),
      ).resolves.toEqual({ outcome: "fresh" });

      const [afterTotp] = await sql<{ second_factor_attempts: number }[]>`
        select second_factor_attempts from identity.sessions where access_hash = ${totpHash}
      `;
      expect(afterTotp?.second_factor_attempts).toBe(0);

      // Two wrong checks followed by a correct check leaves attempts at 2 (only the correct attempt is returned)
      const right2 = totpCode(enrolledTotp.key, stepAt(t2));
      const wrong2 = right2 === "000000" ? "111111" : "000000";
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: enrolledTotp.tokens.accessToken,
          now: t2,
          code: wrong2,
        }),
      ).resolves.toEqual({ outcome: "refused" });
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: enrolledTotp.tokens.accessToken,
          now: t2,
          code: wrong2,
        }),
      ).resolves.toEqual({ outcome: "refused" });
      await expect(
        freshCheckTotp(sql, kms, KEY_ARN, {
          accessToken: enrolledTotp.tokens.accessToken,
          now: t2,
          code: right2,
        }),
      ).resolves.toEqual({ outcome: "fresh" });

      const [afterPartial] = await sql<{ second_factor_attempts: number }[]>`
        select second_factor_attempts from identity.sessions where access_hash = ${totpHash}
      `;
      expect(afterPartial?.second_factor_attempts).toBe(2);

      // Passkey fresh check starting at 0 also stays at 0
      const { userId: pkUserId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "floor-pk@example.test",
      });
      const enrolledPk = await registerTenantPasskeyForTest(sql, kms, pkUserId, now);
      const pkHash = await sessionAccessHash(sql, kms, KEY_ARN, enrolledPk.tokens.accessToken);
      const opts = await beginFreshPasskey(sql, kms, KEY_ARN, {
        accessToken: enrolledPk.tokens.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
      });
      if (opts.outcome !== "started") {
        throw new Error("expected started");
      }
      const authData = authenticatorDataBytes({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const client = clientDataBytes("webauthn.get", opts.options.challenge, ADMIN_ORIGIN);
      await expect(
        verifyFreshPasskey(sql, kms, KEY_ARN, {
          accessToken: enrolledPk.tokens.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
          credentialId: enrolledPk.credentialId,
          clientDataJSON: client,
          authenticatorData: authData,
          signature: await enrolledPk.key.sign(concatBytes([authData, await sha256Bytes(client)])),
        }),
      ).resolves.toEqual({ outcome: "fresh" });

      const [afterPk] = await sql<{ second_factor_attempts: number }[]>`
        select second_factor_attempts from identity.sessions where access_hash = ${pkHash}
      `;
      expect(afterPk?.second_factor_attempts).toBe(0);
    });
  });
});

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

async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
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

async function registerTenantPasskeyForTest(
  sql: Sql,
  kms: KmsPort,
  userId: string,
  now: Date,
): Promise<{
  credentialId: Uint8Array;
  key: Awaited<ReturnType<typeof generatePasskeySigner>>;
  tokens: SessionTokens;
  backupCodes: string[];
}> {
  const sf = await createSession(sql, kms, KEY_ARN, { userId, now, kind: "second_factor" });
  const started = await beginTenantPasskeyRegistration(sql, kms, KEY_ARN, {
    accessToken: sf.accessToken,
    now,
    adminRpId: ADMIN_RP_ID,
  });
  if (started.outcome !== "started") {
    throw new Error("expected tenant passkey registration start");
  }
  const key = await generatePasskeySigner();
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const authData = authenticatorDataBytes({
    rpId: ADMIN_RP_ID,
    signCount: 0,
    credentialId,
    cose: coseKeyBytes(key.x, key.y),
    flags: 0x45,
  });
  const enrolled = await finishTenantPasskeyRegistration(
    sql,
    kms,
    KEY_ARN,
    {
      accessToken: sf.accessToken,
      now,
      adminRpId: ADMIN_RP_ID,
      clientDataJSON: clientDataBytes("webauthn.create", started.options.challenge, ADMIN_ORIGIN),
      attestationObject: attestationObjectBytes(authData),
    },
    { notice: new MemoryNotice() },
  );
  if (enrolled.outcome !== "enrolled" || !enrolled.tokens) {
    throw new Error("expected first-factor passkey enrolment");
  }
  return { credentialId, key, tokens: enrolled.tokens, backupCodes: enrolled.backupCodes };
}
