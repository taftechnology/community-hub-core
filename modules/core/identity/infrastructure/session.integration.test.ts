import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "@community-hub/db/plaintext";
import { beforeAll, describe, expect, it } from "vitest";

import type { OtpMail } from "../domain/otp-mail.js";
import { readSession, refreshSession, startEmailOtp, verifyEmailOtp } from "../public/index.js";

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

function pauseOnSessionInsert(sql: Sql): {
  bound: Sql;
  reached: Promise<void>;
  release: () => void;
} {
  let releaseInsert = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    releaseInsert = resolve;
  });
  let markReached = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  let armed = true;
  const originalBegin = sql.begin.bind(sql);
  const bound = new Proxy(sql, {
    apply(target, thisArg, argArray) {
      return Reflect.apply(target, thisArg, argArray);
    },
    get(target, prop, receiver) {
      if (prop === "begin") {
        return (fn: (tx: Sql) => Promise<unknown>) =>
          originalBegin(async (tx) => {
            const wrapped = new Proxy(tx, {
              apply(txTarget, txThis, txArgs) {
                const strings = txArgs[0];
                const text = Array.isArray(strings) ? strings.join("") : "";
                if (armed && text.includes("insert into identity.sessions")) {
                  armed = false;
                  markReached();
                  return released.then(() => Reflect.apply(txTarget, txThis, txArgs));
                }
                return Reflect.apply(txTarget, txThis, txArgs);
              },
            });
            return fn(wrapped as unknown as Sql);
          });
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { bound, reached, release: releaseInsert };
}

class MemoryMail implements OtpMail {
  last: { to: string; code: string } | undefined;

  send(input: { to: string; code: string }): Promise<void> {
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

describe("sessions", () => {
  async function clearIdentity(sql: ReturnType<typeof createPlaintextIdentitySql>): Promise<void> {
    await sql`delete from identity.sessions`;
    await sql`delete from identity.passkey_credentials`;
    await sql`delete from identity.passkey_challenges`;
    await sql`delete from identity.otp_challenges`;
    await sql`delete from identity.users`;
    await sql`delete from identity.identity_keys`;
  }

  it("rotates a refresh token and revokes the family when that token is reused", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const later = new Date(now.getTime() + 15 * 60 * 1000 + 1);
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      await clearIdentity(sql);
      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now });
      const opened = await verifyEmailOtp(sql, kms, KEY_ARN, {
        email: "ada@example.com",
        code: mail.last?.code ?? "",
        now,
      });
      expect(opened).toMatchObject({ userId: expect.any(String), expiresIn: 900 });
      if (opened === null) {
        throw new Error("session was not opened");
      }

      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: opened.accessToken, now }),
      ).toEqual({ userId: opened.userId });
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: opened.accessToken, now: later }),
      ).toBeNull();

      const rotated = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: opened.refreshToken,
        now,
      });
      expect(rotated).toMatchObject({ userId: opened.userId, expiresIn: 900 });
      if (rotated === null) {
        throw new Error("session was not rotated");
      }
      expect(rotated.accessToken).not.toBe(opened.accessToken);
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: opened.accessToken, now }),
      ).toBeNull();
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: rotated.accessToken, now }),
      ).toEqual({ userId: opened.userId });

      expect(
        await refreshSession(sql, kms, KEY_ARN, { refreshToken: opened.refreshToken, now }),
      ).toBeNull();
      expect(
        await refreshSession(sql, kms, KEY_ARN, { refreshToken: rotated.refreshToken, now }),
      ).toBeNull();
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: rotated.accessToken, now }),
      ).toBeNull();

      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now });
      const expired = await verifyEmailOtp(sql, kms, KEY_ARN, {
        email: "ada@example.com",
        code: mail.last?.code ?? "",
        now,
      });
      if (expired === null) {
        throw new Error("session was not opened");
      }
      expect(
        await refreshSession(sql, kms, KEY_ARN, {
          refreshToken: expired.refreshToken,
          now: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000 + 1),
        }),
      ).toBeNull();
    } finally {
      await clearIdentity(sql);
      await sql.end({ timeout: 1 });
    }
  });

  it("returns one session when one refresh token is presented twice in parallel", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    const runtime = loadRuntime();
    const url = identityUrl(runtime);
    const holder = postgres(url, { max: 1, prepare: true, onnotice: () => undefined });
    const sql = postgres(url, { max: 4, prepare: true, onnotice: () => undefined });
    const observer = createPlaintextDirectSql(runtime.productOnlyUrl);
    let pending: Promise<Awaited<ReturnType<typeof refreshSession>>[]> = Promise.resolve([]);
    try {
      await clearIdentity(sql);
      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now });
      const opened = await verifyEmailOtp(sql, kms, KEY_ARN, {
        email: "ada@example.com",
        code: mail.last?.code ?? "",
        now,
      });
      if (opened === null) {
        throw new Error("session was not opened");
      }
      let locked: () => void = () => undefined;
      const lockHeld = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const gate = holder.begin(async (tx) => {
        await tx`select id from identity.sessions for update`;
        locked();
        const started = Date.now();
        while (Date.now() - started < 5_000) {
          const waiting = await observer<{ n: number }[]>`
            select count(*)::int as n
            from pg_stat_activity
            where datname = current_database()
              and state = 'active'
              and wait_event_type = 'Lock'
              and (
                query like '%update identity.sessions%'
                or query like '%pg_advisory_xact_lock%'
              )
          `;
          if ((waiting[0]?.n ?? 0) >= 2) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        throw new Error("refreshes did not wait on the session");
      });
      await lockHeld;
      pending = Promise.all([
        refreshSession(sql, kms, KEY_ARN, { refreshToken: opened.refreshToken, now }),
        refreshSession(sql, kms, KEY_ARN, { refreshToken: opened.refreshToken, now }),
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

  it("leaves no live row when reuse is detected during a rotation", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const mail = new MemoryMail();
    const kms = createLocalKmsPort();
    const runtime = loadRuntime();
    const sql = postgres(identityUrl(runtime), {
      max: 4,
      prepare: true,
      onnotice: () => undefined,
    });
    const observer = createPlaintextDirectSql(runtime.productOnlyUrl);
    let rotation: Promise<Awaited<ReturnType<typeof refreshSession>>> = Promise.resolve(null);
    let reuse: Promise<Awaited<ReturnType<typeof refreshSession>>> = Promise.resolve(null);
    let release = (): void => undefined;
    try {
      await clearIdentity(sql);
      await startEmailOtp(sql, kms, KEY_ARN, mail, { email: "ada@example.com", now });
      const opened = await verifyEmailOtp(sql, kms, KEY_ARN, {
        email: "ada@example.com",
        code: mail.last?.code ?? "",
        now,
      });
      if (opened === null) {
        throw new Error("session was not opened");
      }
      const rotated = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: opened.refreshToken,
        now,
      });
      if (rotated === null) {
        throw new Error("session was not rotated");
      }
      const families = await sql<{ refresh_family: string }[]>`
        select refresh_family from identity.sessions limit 1
      `;
      const family = families[0]?.refresh_family;
      if (family === undefined) {
        throw new Error("refresh family is missing");
      }
      const paused = pauseOnSessionInsert(sql);
      release = paused.release;
      rotation = refreshSession(paused.bound, kms, KEY_ARN, {
        refreshToken: rotated.refreshToken,
        now,
      });
      await paused.reached;
      reuse = refreshSession(paused.bound, kms, KEY_ARN, {
        refreshToken: opened.refreshToken,
        now,
      });
      const started = Date.now();
      let waiting = false;
      while (Date.now() - started < 5_000) {
        const rows = await observer<{ n: number }[]>`
          select count(*)::int as n
          from pg_stat_activity
          where datname = current_database()
            and state = 'active'
            and wait_event_type = 'Lock'
            and (
              query like '%identity.sessions%'
              or query like '%pg_advisory_xact_lock%'
            )
        `;
        if ((rows[0]?.n ?? 0) >= 1) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      if (!waiting) {
        throw new Error("reuse did not wait during rotation");
      }
      release();
      await rotation;
      await reuse;
      const live = await sql<{ n: number }[]>`
        select count(*)::int as n
        from identity.sessions
        where refresh_family = ${family}
          and revoked_at is null
      `;
      expect(Number(live[0]?.n)).toBe(0);
    } finally {
      release();
      await rotation.catch(() => undefined);
      await reuse.catch(() => undefined);
      await clearIdentity(sql);
      await sql.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
    }
  }, 15_000);
});
