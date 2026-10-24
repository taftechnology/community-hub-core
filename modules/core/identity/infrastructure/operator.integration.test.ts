import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId } from "@community-hub/db";
import {
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { insertIdentityUser } from "./identity-user.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "identity" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

describe("operator tables privileges", () => {
  const kms = createLocalKmsPort();

  beforeAll(async () => {
    const runtime = loadRuntime();
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await applyProductMigrations(direct);
      try {
        await direct`delete from identity.operator_events`;
        await direct`delete from identity.operator_grants`;
      } catch {
        // Tables might not exist on initial RED run before migration 0012
      }
      await direct`delete from identity.identity_keys`;
      await direct`delete from identity.sessions`;
      await direct`delete from identity.users`;
    } finally {
      await direct.end({ timeout: 1 });
    }
  });

  afterAll(async () => {
    const runtime = loadRuntime();
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      try {
        await direct`delete from identity.operator_events`;
        await direct`delete from identity.operator_grants`;
      } catch {
        // Tables might not exist on initial RED run before migration 0012
      }
      await direct`delete from identity.identity_keys`;
      await direct`delete from identity.sessions`;
      await direct`delete from identity.users`;
    } finally {
      await direct.end({ timeout: 1 });
    }
  });

  it("enforces append-only on operator_events and restricted delete on operator_grants for identity role", async () => {
    const runtime = loadRuntime();
    const identitySql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    try {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "operator-priv@example.test",
      });
      const grantId = newId();
      const now = new Date("2026-10-24T12:00:00.000Z");
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const codeHash = Buffer.from("enrolment-code-hash-placeholder-32b");

      // Positive case: identity role can insert into operator_grants
      await identitySql`
        insert into identity.operator_grants (
          id, user_id, role_key, enrolment_code_hash, granted_at, enrolment_expires_at
        ) values (
          ${grantId}, ${user.userId}, 'platform_admin', ${codeHash}, ${now}, ${expiresAt}
        )
      `;

      // Positive case: identity role can update operator_grants
      const activatedAt = new Date("2026-10-24T13:00:00.000Z");
      await identitySql`
        update identity.operator_grants
        set activated_at = ${activatedAt}
        where id = ${grantId}
      `;
      const [updatedGrant] = await identitySql<{ activated_at: Date }[]>`
        select activated_at from identity.operator_grants where id = ${grantId}
      `;
      expect(updatedGrant?.activated_at).toEqual(activatedAt);

      // Positive case: identity role can insert into operator_events
      const eventId = newId();
      await identitySql`
        insert into identity.operator_events (
          id, user_id, action, role_key, occurred_at
        ) values (
          ${eventId}, ${user.userId}, 'granted', 'platform_admin', ${now}
        )
      `;

      // Identity role CANNOT update operator_events (fails with 42501)
      await expect(
        identitySql`update identity.operator_events set action = 'revoked' where id = ${eventId}`,
      ).rejects.toMatchObject({ code: "42501" });

      // Identity role CANNOT delete operator_events (fails with 42501)
      await expect(
        identitySql`delete from identity.operator_events where id = ${eventId}`,
      ).rejects.toMatchObject({ code: "42501" });

      // Identity role CANNOT delete operator_grants (fails with 42501)
      await expect(
        identitySql`delete from identity.operator_grants where id = ${grantId}`,
      ).rejects.toMatchObject({ code: "42501" });

      // Identity role has NO TRUNCATE privilege on either table
      const [privs] = await identitySql<{ events_truncate: boolean; grants_truncate: boolean }[]>`
        select
          has_table_privilege('identity', 'identity.operator_events', 'TRUNCATE') as events_truncate,
          has_table_privilege('identity', 'identity.operator_grants', 'TRUNCATE') as grants_truncate
      `;
      expect(privs).toEqual({ events_truncate: false, grants_truncate: false });
    } finally {
      await identitySql.end({ timeout: 1 });
    }
  });

  it("denies select on operator_grants to platform role", async () => {
    const runtime = loadRuntime();
    const platformSql = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    try {
      await expect(platformSql`select id from identity.operator_grants`).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await platformSql.end({ timeout: 1 });
    }
  });

  it("enforces operator_grants_role_key check constraint", async () => {
    const runtime = loadRuntime();
    const identitySql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    try {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "operator-grant-check@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const codeHash = Buffer.from("enrolment-code-hash-placeholder-32b");

      await expect(
        identitySql`
          insert into identity.operator_grants (
            id, user_id, role_key, enrolment_code_hash, granted_at, enrolment_expires_at
          ) values (
            ${newId()}, ${user.userId}, 'member', ${codeHash}, ${now}, ${expiresAt}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await identitySql.end({ timeout: 1 });
    }
  });

  it("enforces operator_events_role_key check constraint", async () => {
    const runtime = loadRuntime();
    const identitySql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    try {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "operator-event-check@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");

      // action = 'signed_in' with role_key fails with 23514
      await expect(
        identitySql`
          insert into identity.operator_events (
            id, user_id, action, role_key, occurred_at
          ) values (
            ${newId()}, ${user.userId}, 'signed_in', 'platform_admin', ${now}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });

      // action = 'granted' without role_key fails with 23514
      await expect(
        identitySql`
          insert into identity.operator_events (
            id, user_id, action, role_key, occurred_at
          ) values (
            ${newId()}, ${user.userId}, 'granted', null, ${now}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });

      // Positive case: action = 'signed_in' without role_key succeeds
      const signedInId = newId();
      await identitySql`
        insert into identity.operator_events (
          id, user_id, action, role_key, occurred_at
        ) values (
          ${signedInId}, ${user.userId}, 'signed_in', null, ${now}
        )
      `;
      const [event] = await identitySql<{ id: string }[]>`
        select id from identity.operator_events where id = ${signedInId}
      `;
      expect(event?.id).toBe(signedInId);
    } finally {
      await identitySql.end({ timeout: 1 });
    }
  });
});
