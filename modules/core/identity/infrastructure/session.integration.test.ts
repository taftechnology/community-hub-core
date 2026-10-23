import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "@community-hub/db/plaintext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OtpMail } from "../domain/otp-mail.js";
import { IdentityError } from "../domain/error.js";
import { insertIdentityUser } from "./identity-user.js";
import { createSession } from "./session.js";
import {
  readSession,
  readSessionWithKind,
  refreshSession,
  startEmailOtp,
  verifyEmailOtp,
} from "../public/index.js";

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

  it("returns null and creates no row when a refresh token is past refresh_expires_at", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const later = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000 + 1);
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
      if (opened === null) {
        throw new Error("session was not opened");
      }
      const before = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.sessions
      `;
      expect(
        await refreshSession(sql, kms, KEY_ARN, { refreshToken: opened.refreshToken, now: later }),
      ).toBeNull();
      const after = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.sessions
      `;
      expect(after).toEqual(before);
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

describe("the sessions check constraint", () => {
  it("rejects invalid combinations of kind and absolute_expires_at, and unknown kinds", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextIdentitySql(identityUrl(runtime));
    const kms = createLocalKmsPort();
    try {
      const email = `constraint-${newId()}@example.test`;
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, { email });
      const now = new Date("2026-10-22T00:00:00.000Z");
      const accessHash = crypto.getRandomValues(new Uint8Array(32));
      const refreshHash = crypto.getRandomValues(new Uint8Array(32));

      // 1. operator row without absolute_expires_at fails with 23514
      await expect(
        sql`
          insert into identity.sessions (
            id, user_id, refresh_family, access_hash, refresh_hash,
            access_expires_at, refresh_expires_at, kind, absolute_expires_at
          ) values (
            ${newId()}, ${userId}, ${newId()}, ${accessHash}, ${refreshHash},
            ${now}, ${now}, 'operator', null
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });

      // 2. tenant row with absolute_expires_at fails with 23514
      await expect(
        sql`
          insert into identity.sessions (
            id, user_id, refresh_family, access_hash, refresh_hash,
            access_expires_at, refresh_expires_at, kind, absolute_expires_at
          ) values (
            ${newId()}, ${userId}, ${newId()}, ${accessHash}, ${refreshHash},
            ${now}, ${now}, 'tenant', ${now}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });

      // 3. row with kind = 'admin' fails with 23514
      await expect(
        sql`
          insert into identity.sessions (
            id, user_id, refresh_family, access_hash, refresh_hash,
            access_expires_at, refresh_expires_at, kind, absolute_expires_at
          ) values (
            ${newId()}, ${userId}, ${newId()}, ${accessHash}, ${refreshHash},
            ${now}, ${now}, 'admin', null
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});

describe("session kinds and absolute expiry", () => {
  const kms = createLocalKmsPort();

  beforeAll(async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextIdentitySql(identityUrl(runtime));
    try {
      await sql`delete from identity.identity_keys`;
      await sql`delete from identity.sessions`;
      await sql`delete from identity.users`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  afterAll(async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextIdentitySql(identityUrl(runtime));
    try {
      await sql`delete from identity.identity_keys`;
      await sql`delete from identity.sessions`;
      await sql`delete from identity.users`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("readSession refuses operator and enrolment sessions by default", async () => {
    const now = new Date("2026-10-22T00:00:00.000Z");
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: `pin1-${newId()}@example.test`,
      });
      const absExp = new Date(now.getTime() + 60 * 60 * 1000);
      const opSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "operator",
        absoluteExpiresAt: absExp,
      });
      const enSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "enrolment",
      });

      // Default readSession (no kinds option) refuses operator and enrolment
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: opSession.accessToken, now }),
      ).toBeNull();
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: enSession.accessToken, now }),
      ).toBeNull();

      // Specifying accepted kind succeeds
      expect(
        await readSession(sql, kms, KEY_ARN, {
          accessToken: opSession.accessToken,
          now,
          kinds: ["operator"],
        }),
      ).toEqual({ userId });
      expect(
        await readSession(sql, kms, KEY_ARN, {
          accessToken: enSession.accessToken,
          now,
          kinds: ["enrolment"],
        }),
      ).toEqual({ userId });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("refreshSession refuses other kinds by default", async () => {
    const now = new Date("2026-10-22T00:00:00.000Z");
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: `pin2-${newId()}@example.test`,
      });
      const absExp = new Date(now.getTime() + 60 * 60 * 1000);
      const opSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "operator",
        absoluteExpiresAt: absExp,
      });
      const enSession = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "enrolment",
      });

      // Default refresh refuses operator
      const opRefused = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: opSession.refreshToken,
        now,
      });
      expect(opRefused).toBeNull();

      // Default refresh refuses enrolment
      const enRefused = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: enSession.refreshToken,
        now,
      });
      expect(enRefused).toBeNull();

      // The operator session's row and family are untouched:
      // It still refreshes with kinds: ["operator"]
      const refreshed = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: opSession.refreshToken,
        now,
        kinds: ["operator"],
      });
      expect(refreshed).not.toBeNull();
      expect(refreshed?.userId).toBe(userId);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("refreshSession refuses enrolment even when listed", async () => {
    const now = new Date("2026-10-22T00:00:00.000Z");
    const later = new Date(now.getTime() + 60 * 1000);
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: `pin2b-${newId()}@example.test`,
      });
      const tenantSession = await createSession(sql, kms, KEY_ARN, { userId, now });
      const enSession1 = await createSession(sql, kms, KEY_ARN, { userId, now, kind: "enrolment" });
      const enSession2 = await createSession(sql, kms, KEY_ARN, { userId, now, kind: "enrolment" });

      // Same-time tenant refresh succeeds
      const tenantRefreshed = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: tenantSession.refreshToken,
        now: later,
      });
      expect(tenantRefreshed).not.toBeNull();

      // Enrolment with ["enrolment"] is refused
      const enRefused1 = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: enSession1.refreshToken,
        now: later,
        kinds: ["enrolment"],
      });
      expect(enRefused1).toBeNull();

      // Enrolment with all three kinds is refused
      const enRefused2 = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: enSession2.refreshToken,
        now: later,
        kinds: ["tenant", "operator", "enrolment"],
      });
      expect(enRefused2).toBeNull();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("operator refresh never passes the absolute expiry", async () => {
    const now = new Date("2026-10-22T00:00:00.000Z");
    const absExp = new Date(now.getTime() + 50 * 60 * 1000); // 50 min
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: `pin3a-${newId()}@example.test`,
      });
      const session = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "operator",
        absoluteExpiresAt: absExp,
      });

      // Check DB row at creation (Pin 3a)
      const rows1 = await sql<{ refresh_expires_at: Date; absolute_expires_at: Date }[]>`
        select refresh_expires_at, absolute_expires_at
        from identity.sessions
        where user_id = ${userId}
      `;
      expect(rows1[0]?.refresh_expires_at).toEqual(absExp);

      // Refresh 1 (at now + 10 min)
      const ref1 = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: session.refreshToken,
        now: new Date(now.getTime() + 10 * 60 * 1000),
        kinds: ["operator"],
      });
      expect(ref1).not.toBeNull();

      // Refresh 2 (at now + 20 min)
      const ref2 = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: ref1!.refreshToken,
        now: new Date(now.getTime() + 20 * 60 * 1000),
        kinds: ["operator"],
      });
      expect(ref2).not.toBeNull();

      // Check successor refresh_expires_at <= absolute_expires_at
      const rows2 = await sql<{ refresh_expires_at: Date }[]>`
        select refresh_expires_at
        from identity.sessions
        where replaced_by is null and user_id = ${userId}
      `;
      expect(rows2[0]?.refresh_expires_at).toEqual(absExp);

      // Refresh 3 after absolute_expires_at (at now + 51 min) (Pin 3b)
      const ref3 = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: ref2!.refreshToken,
        now: new Date(now.getTime() + 51 * 60 * 1000),
        kinds: ["operator"],
      });
      expect(ref3).toBeNull();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("operator access ends at the absolute expiry", async () => {
    const now = new Date("2026-10-22T00:00:00.000Z");
    const absExp = new Date(now.getTime() + 5 * 60 * 1000); // 5 min from now
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: `pin3c-${newId()}@example.test`,
      });
      const session = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "operator",
        absoluteExpiresAt: absExp,
      });

      // Check DB row access_expires_at is absExp
      const rows = await sql<{ access_expires_at: Date }[]>`
        select access_expires_at from identity.sessions where user_id = ${userId}
      `;
      expect(rows[0]?.access_expires_at).toEqual(absExp);

      // Readable at now + 4 min
      const readable = await readSession(sql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        now: new Date(now.getTime() + 4 * 60 * 1000),
        kinds: ["operator"],
      });
      expect(readable).toEqual({ userId });

      // Unreadable 1 min after absolute expiry (at now + 6 min)
      const unreadable = await readSession(sql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        now: new Date(now.getTime() + 6 * 60 * 1000),
        kinds: ["operator"],
      });
      expect(unreadable).toBeNull();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("reports expiresIn from the stored access expiry for capped operator sessions", async () => {
    const now = new Date("2026-10-22T00:00:00.000Z");
    const absExp = new Date(now.getTime() + 5 * 60 * 1000);
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: `expires-in-${newId()}@example.test`,
      });

      const tenant = await createSession(sql, kms, KEY_ARN, { userId, now });
      expect(tenant.expiresIn).toBe(900);

      const operator = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "operator",
        absoluteExpiresAt: absExp,
      });
      expect(operator.expiresIn).toBeGreaterThan(0);
      expect(operator.expiresIn).toBeLessThanOrEqual(300);

      const rotated = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: operator.refreshToken,
        now,
        kinds: ["operator"],
      });
      expect(rotated).not.toBeNull();
      expect(rotated!.expiresIn).toBeGreaterThan(0);
      expect(rotated!.expiresIn).toBeLessThanOrEqual(300);

      const tenantRotated = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: tenant.refreshToken,
        now,
      });
      expect(tenantRotated).not.toBeNull();
      expect(tenantRotated!.expiresIn).toBe(900);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("a tenant session created with no options reads, refreshes and carries kind = 'tenant' in the row", async () => {
    const now = new Date("2026-10-22T00:00:00.000Z");
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: `tenant-def-${newId()}@example.test`,
      });
      const session = await createSession(sql, kms, KEY_ARN, { userId, now });

      const rows = await sql<{ kind: string; absolute_expires_at: Date | null }[]>`
        select kind, absolute_expires_at from identity.sessions where user_id = ${userId}
      `;
      expect(rows[0]?.kind).toBe("tenant");
      expect(rows[0]?.absolute_expires_at).toBeNull();

      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: session.accessToken, now }),
      ).toEqual({ userId });

      const rotated = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: session.refreshToken,
        now,
      });
      expect(rotated).not.toBeNull();

      const successorRows = await sql<{ kind: string; absolute_expires_at: Date | null }[]>`
        select kind, absolute_expires_at
        from identity.sessions
        where user_id = ${userId} and replaced_by is null
      `;
      expect(successorRows[0]?.kind).toBe("tenant");
      expect(successorRows[0]?.absolute_expires_at).toBeNull();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("readSessionWithKind returns the kind", async () => {
    const now = new Date("2026-10-22T00:00:00.000Z");
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: `rswk-${newId()}@example.test`,
      });
      const absExp = new Date(now.getTime() + 60 * 60 * 1000);
      const tenant = await createSession(sql, kms, KEY_ARN, { userId, now, kind: "tenant" });
      const op = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "operator",
        absoluteExpiresAt: absExp,
      });
      const en = await createSession(sql, kms, KEY_ARN, { userId, now, kind: "enrolment" });

      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: tenant.accessToken,
          now,
          kinds: ["tenant"],
        }),
      ).toEqual({ userId, kind: "tenant" });
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: op.accessToken,
          now,
          kinds: ["operator"],
        }),
      ).toEqual({ userId, kind: "operator" });
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: en.accessToken,
          now,
          kinds: ["enrolment"],
        }),
      ).toEqual({ userId, kind: "enrolment" });

      // Not matching kind returns null
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: op.accessToken,
          now,
          kinds: ["tenant"],
        }),
      ).toBeNull();

      // Empty kinds matches nothing
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: tenant.accessToken,
          now,
          kinds: [],
        }),
      ).toBeNull();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("createSession throws for operator without absoluteExpiresAt and with one not after now", async () => {
    const now = new Date("2026-10-22T00:00:00.000Z");
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: `throw-${newId()}@example.test`,
      });

      // operator without absoluteExpiresAt
      await expect(
        createSession(sql, kms, KEY_ARN, { userId, now, kind: "operator" }),
      ).rejects.toBeInstanceOf(IdentityError);

      // operator with absoluteExpiresAt equal to now
      await expect(
        createSession(sql, kms, KEY_ARN, {
          userId,
          now,
          kind: "operator",
          absoluteExpiresAt: now,
        }),
      ).rejects.toBeInstanceOf(IdentityError);

      // operator with absoluteExpiresAt in past
      await expect(
        createSession(sql, kms, KEY_ARN, {
          userId,
          now,
          kind: "operator",
          absoluteExpiresAt: new Date(now.getTime() - 1000),
        }),
      ).rejects.toBeInstanceOf(IdentityError);

      // tenant with absoluteExpiresAt
      await expect(
        createSession(sql, kms, KEY_ARN, {
          userId,
          now,
          kind: "tenant",
          absoluteExpiresAt: new Date(now.getTime() + 1000),
        }),
      ).rejects.toBeInstanceOf(IdentityError);

      // enrolment with absoluteExpiresAt
      await expect(
        createSession(sql, kms, KEY_ARN, {
          userId,
          now,
          kind: "enrolment",
          absoluteExpiresAt: new Date(now.getTime() + 1000),
        }),
      ).rejects.toBeInstanceOf(IdentityError);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("stores an enrolment session created through createSession", async () => {
    const now = new Date("2026-10-22T00:00:00.000Z");
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: `en-stored-${newId()}@example.test`,
      });
      await createSession(sql, kms, KEY_ARN, { userId, now, kind: "enrolment" });

      const rows = await sql<
        {
          kind: string;
          absolute_expires_at: Date | null;
          access_expires_at: Date;
          refresh_expires_at: Date;
        }[]
      >`
        select kind, absolute_expires_at, access_expires_at, refresh_expires_at
        from identity.sessions
        where user_id = ${userId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("enrolment");
      expect(rows[0]?.absolute_expires_at).toBeNull();
      expect(rows[0]?.refresh_expires_at).toEqual(rows[0]?.access_expires_at);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("stores an operator session with a future absoluteExpiresAt created through createSession", async () => {
    const now = new Date("2026-10-22T00:00:00.000Z");
    const absExp = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: `op-stored-${newId()}@example.test`,
      });
      await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "operator",
        absoluteExpiresAt: absExp,
      });

      const rows = await sql<{ kind: string; absolute_expires_at: Date }[]>`
        select kind, absolute_expires_at
        from identity.sessions
        where user_id = ${userId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("operator");
      expect(rows[0]?.absolute_expires_at).toEqual(absExp);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("presenting a rotated operator refresh token with default kinds does not revoke the family", async () => {
    const now = new Date("2026-10-22T00:00:00.000Z");
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: `pin2-locate-${newId()}@example.test`,
      });
      const absExp = new Date(now.getTime() + 60 * 60 * 1000);
      const original = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "operator",
        absoluteExpiresAt: absExp,
      });

      // Refresh with kinds: ["operator"] to get a successor (original token is now rotated)
      const rotated = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: original.refreshToken,
        now: new Date(now.getTime() + 10 * 1000),
        kinds: ["operator"],
      });
      expect(rotated).not.toBeNull();
      if (rotated === null) {
        throw new Error("successor session was not created");
      }

      // Present the ORIGINAL token to refreshSession with default kinds: expect null
      const defaultRefresh = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: original.refreshToken,
        now: new Date(now.getTime() + 20 * 1000),
      });
      expect(defaultRefresh).toBeNull();

      // The successor's row and family are not revoked
      const successorRows = await sql<{ refresh_family: string; revoked_at: Date | null }[]>`
        select refresh_family, revoked_at
        from identity.sessions
        where user_id = ${userId} and replaced_by is null
      `;
      expect(successorRows).toHaveLength(1);
      expect(successorRows[0]?.revoked_at).toBeNull();

      const liveFamilyRows = await sql<{ n: number }[]>`
        select count(*)::int as n
        from identity.sessions
        where refresh_family = ${successorRows[0]!.refresh_family} and revoked_at is null
      `;
      expect(Number(liveFamilyRows[0]?.n)).toBe(1);

      // And the successor still refreshes with kinds: ["operator"]
      const refreshedSuccessor = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: rotated.refreshToken,
        now: new Date(now.getTime() + 30 * 1000),
        kinds: ["operator"],
      });
      expect(refreshedSuccessor).not.toBeNull();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("operator access token ends at absolute expiry on refresh", async () => {
    const now = new Date("2026-10-22T00:00:00.000Z");
    const absoluteExpiresAt = new Date(now.getTime() + 60 * 60 * 1000);
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: `pin3c-ref-${newId()}@example.test`,
      });
      const session = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "operator",
        absoluteExpiresAt,
      });

      // Refresh at absolute - 5 min with kinds: ["operator"]
      const refreshNow = new Date(absoluteExpiresAt.getTime() - 5 * 60 * 1000);
      const refreshed = await refreshSession(sql, kms, KEY_ARN, {
        refreshToken: session.refreshToken,
        now: refreshNow,
        kinds: ["operator"],
      });
      expect(refreshed).not.toBeNull();
      if (refreshed === null) {
        throw new Error("refreshSession returned null");
      }

      // Successor's access_expires_at equals absoluteExpiresAt
      const successorRows = await sql<{ access_expires_at: Date }[]>`
        select access_expires_at
        from identity.sessions
        where user_id = ${userId} and replaced_by is null
      `;
      expect(successorRows).toHaveLength(1);
      expect(successorRows[0]?.access_expires_at).toEqual(absoluteExpiresAt);

      // readSessionWithKind (kinds: ["operator"]) succeeds 1 minute before absolute
      const beforeAbs = new Date(absoluteExpiresAt.getTime() - 60 * 1000);
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: refreshed.accessToken,
          now: beforeAbs,
          kinds: ["operator"],
        }),
      ).toEqual({ userId, kind: "operator" });

      // readSessionWithKind (kinds: ["operator"]) returns null 1 minute after absolute
      const afterAbs = new Date(absoluteExpiresAt.getTime() + 60 * 1000);
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: refreshed.accessToken,
          now: afterAbs,
          kinds: ["operator"],
        }),
      ).toBeNull();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
