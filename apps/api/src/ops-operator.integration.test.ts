import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "@community-hub/db/plaintext";
import {
  findOrCreateUserByEmail,
  findUserByEmail,
  grantOperator,
  IdentityError,
} from "@community-hub/identity";

import { runOpsOperator, type OpsOperatorDeps, type OpsOperatorResult } from "./ops-operator.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/test/.runtime.json",
);

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "identity" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const ARN =
  "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-provision-owner-ab12CD";
const OPS_RP_ID = "ops.example.test";
const BASE_NOW = new Date("2026-10-26T12:00:00.000Z");

const kms = createLocalKmsPort();

let newIdCount = 0;
let lastGeneratedId = "";
function countingNewId(): string {
  newIdCount++;
  lastGeneratedId = newId();
  return lastGeneratedId;
}

let directSql: ReturnType<typeof createPlaintextDirectSql>;
let identitySql: ReturnType<typeof createPlaintextIdentitySql>;

beforeAll(async () => {
  const runtime = loadRuntime();
  directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
  identitySql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));

  await applyProductMigrations(directSql);
  await directSql`delete from identity.operator_events`;
  await directSql`delete from identity.operator_grants`;
  await identitySql`delete from identity.identity_keys`;
});

afterAll(async () => {
  try {
    await directSql`delete from identity.operator_events`;
    await directSql`delete from identity.operator_grants`;
  } finally {
    await identitySql.end({ timeout: 1 });
    await directSql.end({ timeout: 1 });
  }
});

async function countUsers(): Promise<number> {
  const rows = await directSql<{ count: string }[]>`
    select count(*)::text as count from identity.users
  `;
  return Number(rows[0]!.count);
}

function makeDeps(payload: unknown, overrides: Partial<OpsOperatorDeps> = {}): OpsOperatorDeps {
  return {
    source: { PROVISION_SECRET_ARN: ARN },
    readSecret: async () => JSON.stringify(payload),
    identity: identitySql,
    kms,
    keyArn: KEY_ARN,
    opsRpId: OPS_RP_ID,
    now: () => BASE_NOW,
    newId: countingNewId,
    ...overrides,
  };
}

async function runWithPayload(payload: unknown): Promise<OpsOperatorResult> {
  return runOpsOperator(makeDeps(payload));
}

describe("ops-operator integration", () => {
  describe("Security pin 5: revoke and recover for an unknown address", () => {
    it("prints user and creates no user for unknown addresses", async () => {
      const countBefore = await countUsers();

      const revokeResult = await runWithPayload({
        opsOperator: {
          action: "revoke",
          email: "pin5-unknown-revoke@example.test",
        },
      });
      expect(revokeResult).toEqual({ exitCode: 1, stdout: "", stderr: "user\n" });
      expect(await countUsers()).toBe(countBefore);

      const recoverResult = await runWithPayload({
        opsOperator: {
          action: "recover",
          email: "pin5-unknown-recover@example.test",
          roleKeys: ["platform_admin"],
          enrolmentCode: "A".repeat(32),
        },
      });
      expect(recoverResult).toEqual({ exitCode: 1, stdout: "", stderr: "user\n" });
      expect(await countUsers()).toBe(countBefore);
    });
  });

  describe("Security pin 6: pre-check prevents a stray user", () => {
    it("grant with a bad role key, a duplicate or a bad code prints refused and creates no user", async () => {
      const countBefore = await countUsers();

      // unknown role key
      const unknownRoleResult = await runWithPayload({
        opsOperator: {
          action: "grant",
          email: "pin6-unknown-role@example.test",
          roleKeys: ["unknown_role"],
          enrolmentCode: "A".repeat(32),
        },
      });
      expect(unknownRoleResult).toEqual({ exitCode: 1, stdout: "", stderr: "refused\n" });
      expect(await countUsers()).toBe(countBefore);

      // duplicate role key
      const duplicateRoleResult = await runWithPayload({
        opsOperator: {
          action: "grant",
          email: "pin6-duplicate-role@example.test",
          roleKeys: ["platform_admin", "platform_admin"],
          enrolmentCode: "A".repeat(32),
        },
      });
      expect(duplicateRoleResult).toEqual({ exitCode: 1, stdout: "", stderr: "refused\n" });
      expect(await countUsers()).toBe(countBefore);

      // 25-character code
      const shortCodeResult = await runWithPayload({
        opsOperator: {
          action: "grant",
          email: "pin6-short-code@example.test",
          roleKeys: ["platform_admin"],
          enrolmentCode: "A".repeat(25),
        },
      });
      expect(shortCodeResult).toEqual({ exitCode: 1, stdout: "", stderr: "refused\n" });
      expect(await countUsers()).toBe(countBefore);
    });
  });

  describe("Security pin 6b: the pre-check agrees with grantOperator", () => {
    it("the pre-check agrees with grantOperator", async () => {
      const samples: { name: string; roleKeys: string[]; enrolmentCode: string }[] = [
        { name: "A*26", roleKeys: ["platform_admin"], enrolmentCode: "A".repeat(26) },
        { name: "A*25", roleKeys: ["platform_admin"], enrolmentCode: "A".repeat(25) },
        { name: "A*128", roleKeys: ["platform_admin"], enrolmentCode: "A".repeat(128) },
        { name: "A*129", roleKeys: ["platform_admin"], enrolmentCode: "A".repeat(129) },
        { name: "a*26", roleKeys: ["platform_admin"], enrolmentCode: "a".repeat(26) },
        {
          name: "hyphenated 26-character code",
          roleKeys: ["platform_admin"],
          enrolmentCode: "A".repeat(13) + "-" + "A".repeat(13),
        },
        {
          name: "spaced 26-character code",
          roleKeys: ["platform_admin"],
          enrolmentCode: "A".repeat(13) + " " + "A".repeat(13),
        },
        { name: "A*25 + =", roleKeys: ["platform_admin"], enrolmentCode: "A".repeat(25) + "=" },
        { name: "A*25 + 0", roleKeys: ["platform_admin"], enrolmentCode: "A".repeat(25) + "0" },
        { name: "ß + A*24", roleKeys: ["platform_admin"], enrolmentCode: "ß" + "A".repeat(24) },
        { name: "[platform_admin]", roleKeys: ["platform_admin"], enrolmentCode: "A".repeat(32) },
        { name: "[]", roleKeys: [], enrolmentCode: "A".repeat(32) },
        {
          name: "[platform_admin, platform_admin]",
          roleKeys: ["platform_admin", "platform_admin"],
          enrolmentCode: "A".repeat(32),
        },
        { name: "[platform_owner]", roleKeys: ["platform_owner"], enrolmentCode: "A".repeat(32) },
      ];

      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i]!;

        // 1. Direct call through grantOperator for a fresh user
        const directEmail = `pin6b-direct-${i}@example.test`;
        const directUser = await findOrCreateUserByEmail(identitySql, kms, KEY_ARN, {
          email: directEmail,
        });

        let directAccepted = false;
        try {
          await grantOperator(identitySql, kms, KEY_ARN, {
            userId: directUser.userId,
            roleKeys: sample.roleKeys,
            enrolmentCode: sample.enrolmentCode,
            opsRpId: OPS_RP_ID,
            now: BASE_NOW,
            requestId: newId(),
          });
          directAccepted = true;
        } catch (error) {
          if (error instanceof IdentityError) {
            directAccepted = false;
          } else {
            throw error;
          }
        }

        // 2. Call through runOpsOperator grant for a fresh address
        const opsEmail = `pin6b-ops-${i}@example.test`;
        const opsResult = await runWithPayload({
          opsOperator: {
            action: "grant",
            email: opsEmail,
            roleKeys: sample.roleKeys,
            enrolmentCode: sample.enrolmentCode,
          },
        });

        const opsUserCreated =
          (await findUserByEmail(identitySql, kms, KEY_ARN, { email: opsEmail })) !== null;
        const opsAccepted = opsResult.exitCode === 0;

        if (directAccepted) {
          expect(opsAccepted, `${sample.name}: ops accepted`).toBe(true);
          expect(opsResult.stdout, `${sample.name}: stdout granted`).toBe("granted\n");
          expect(opsUserCreated, `${sample.name}: user created`).toBe(true);
        } else {
          expect(opsAccepted, `${sample.name}: ops refused`).toBe(false);
          expect(opsResult.exitCode, `${sample.name}: ops exited with 1`).toBe(1);
          expect(opsUserCreated, `${sample.name}: pre-check prevented user creation`).toBe(false);
        }
      }
    });
  });

  describe("Security pin 8: conflicting grant -> refused, nothing changed", () => {
    it("a second grant for an open role prints refused and changes nothing", async () => {
      const email = "pin8-conflict@example.test";

      // First run: grant platform_admin
      const firstResult = await runWithPayload({
        opsOperator: {
          action: "grant",
          email,
          roleKeys: ["platform_admin"],
          enrolmentCode: "A".repeat(32),
        },
      });
      expect(firstResult).toEqual({ exitCode: 0, stdout: "granted\n", stderr: "" });

      const user = await findUserByEmail(identitySql, kms, KEY_ARN, { email });
      expect(user).not.toBeNull();

      const grantsBefore = await directSql<{ count: string }[]>`
        select count(*)::text as count from identity.operator_grants where user_id = ${user!.userId}
      `;
      const eventsBefore = await directSql<{ count: string }[]>`
        select count(*)::text as count from identity.operator_events where user_id = ${user!.userId}
      `;

      // Second run: grant the same role again
      const secondResult = await runWithPayload({
        opsOperator: {
          action: "grant",
          email,
          roleKeys: ["platform_admin"],
          enrolmentCode: "B".repeat(32),
        },
      });
      expect(secondResult).toEqual({ exitCode: 1, stdout: "", stderr: "refused\n" });

      const grantsAfter = await directSql<{ count: string }[]>`
        select count(*)::text as count from identity.operator_grants where user_id = ${user!.userId}
      `;
      const eventsAfter = await directSql<{ count: string }[]>`
        select count(*)::text as count from identity.operator_events where user_id = ${user!.userId}
      `;

      expect(grantsAfter[0]!.count).toBe(grantsBefore[0]!.count);
      expect(eventsAfter[0]!.count).toBe(eventsBefore[0]!.count);
    });
  });

  describe("Plus: lifecycle operations, events, and edge cases", () => {
    it("grant: creates user, open grants for named roles, granted events with requestId, newId called once", async () => {
      const email = "plus-grant-lifecycle@example.test";
      const code = "C".repeat(32);
      newIdCount = 0;

      const result = await runWithPayload({
        opsOperator: {
          action: "grant",
          email,
          roleKeys: ["platform_admin", "platform_support"],
          enrolmentCode: code,
        },
      });

      expect(result).toEqual({ exitCode: 0, stdout: "granted\n", stderr: "" });
      expect(newIdCount).toBe(1);

      const user = await findUserByEmail(identitySql, kms, KEY_ARN, { email });
      expect(user).not.toBeNull();

      const userRows = await directSql<{ id: string }[]>`
        select id::text as id from identity.users where id = ${user!.userId}
      `;
      expect(userRows).toHaveLength(1);

      const grants = await directSql<
        {
          role_key: string;
          revoked_at: string | null;
          activated_at: string | null;
        }[]
      >`
        select role_key, revoked_at::text, activated_at::text
        from identity.operator_grants
        where user_id = ${user!.userId}
        order by role_key
      `;
      expect(grants).toHaveLength(2);
      expect(grants[0]!.role_key).toBe("platform_admin");
      expect(grants[0]!.revoked_at).toBeNull();
      expect(grants[0]!.activated_at).toBeNull();
      expect(grants[1]!.role_key).toBe("platform_support");
      expect(grants[1]!.revoked_at).toBeNull();
      expect(grants[1]!.activated_at).toBeNull();

      const events = await directSql<{ action: string; role_key: string; request_id: string }[]>`
        select action, role_key, request_id
        from identity.operator_events
        where user_id = ${user!.userId}
        order by role_key
      `;
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        action: "granted",
        role_key: "platform_admin",
        request_id: lastGeneratedId,
      });
      expect(events[1]).toEqual({
        action: "granted",
        role_key: "platform_support",
        request_id: lastGeneratedId,
      });
    });

    it("revoke: revokes all user grants and prints revoked", async () => {
      const email = "plus-revoke@example.test";
      await runWithPayload({
        opsOperator: {
          action: "grant",
          email,
          roleKeys: ["platform_admin"],
          enrolmentCode: "A".repeat(32),
        },
      });

      const user = await findUserByEmail(identitySql, kms, KEY_ARN, { email });
      expect(user).not.toBeNull();

      const result = await runWithPayload({
        opsOperator: {
          action: "revoke",
          email,
        },
      });
      expect(result).toEqual({ exitCode: 0, stdout: "revoked\n", stderr: "" });

      const grants = await directSql<{ role_key: string; revoked_at: string | null }[]>`
        select role_key, revoked_at::text
        from identity.operator_grants
        where user_id = ${user!.userId}
      `;
      expect(grants).toHaveLength(1);
      expect(grants[0]!.revoked_at).not.toBeNull();

      const revokeEvents = await directSql<{ action: string }[]>`
        select action from identity.operator_events
        where user_id = ${user!.userId} and action = 'revoked'
      `;
      expect(revokeEvents).toHaveLength(1);
    });

    it("recover: recovers user with recovery_regrant event and new open grants", async () => {
      const email = "plus-recover@example.test";
      await runWithPayload({
        opsOperator: {
          action: "grant",
          email,
          roleKeys: ["platform_admin"],
          enrolmentCode: "A".repeat(32),
        },
      });

      const user = await findUserByEmail(identitySql, kms, KEY_ARN, { email });
      expect(user).not.toBeNull();

      const result = await runWithPayload({
        opsOperator: {
          action: "recover",
          email,
          roleKeys: ["platform_security"],
          enrolmentCode: "B".repeat(32),
        },
      });
      expect(result).toEqual({ exitCode: 0, stdout: "recovered\n", stderr: "" });

      const recoveryEvents = await directSql<{ action: string; request_id: string }[]>`
        select action, request_id from identity.operator_events
        where user_id = ${user!.userId} and action = 'recovery_regrant'
      `;
      expect(recoveryEvents).toHaveLength(1);

      const grants = await directSql<{ role_key: string; revoked_at: string | null }[]>`
        select role_key, revoked_at::text
        from identity.operator_grants
        where user_id = ${user!.userId}
        order by role_key
      `;
      expect(grants).toHaveLength(2);
      const adminGrant = grants.find((g) => g.role_key === "platform_admin");
      const securityGrant = grants.find((g) => g.role_key === "platform_security");
      expect(adminGrant?.revoked_at).not.toBeNull();
      expect(securityGrant?.revoked_at).toBeNull();
    });

    it("recover with a 25-character code: refused and nothing changed", async () => {
      const email = "plus-recover-short@example.test";
      await runWithPayload({
        opsOperator: {
          action: "grant",
          email,
          roleKeys: ["platform_admin"],
          enrolmentCode: "A".repeat(32),
        },
      });

      const user = await findUserByEmail(identitySql, kms, KEY_ARN, { email });
      expect(user).not.toBeNull();

      const grantsBefore = await directSql<{ count: string }[]>`
        select count(*)::text as count from identity.operator_grants where user_id = ${user!.userId}
      `;
      const eventsBefore = await directSql<{ count: string }[]>`
        select count(*)::text as count from identity.operator_events where user_id = ${user!.userId}
      `;

      const result = await runWithPayload({
        opsOperator: {
          action: "recover",
          email,
          roleKeys: ["platform_admin"],
          enrolmentCode: "A".repeat(25),
        },
      });
      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "refused\n" });

      const grantsAfter = await directSql<{ count: string }[]>`
        select count(*)::text as count from identity.operator_grants where user_id = ${user!.userId}
      `;
      const eventsAfter = await directSql<{ count: string }[]>`
        select count(*)::text as count from identity.operator_events where user_id = ${user!.userId}
      `;
      expect(grantsAfter[0]!.count).toBe(grantsBefore[0]!.count);
      expect(eventsAfter[0]!.count).toBe(eventsBefore[0]!.count);
    });

    it("malformed address on grant: refused and no user created", async () => {
      const countBefore = await countUsers();
      const email = "not-an-address";

      const result = await runWithPayload({
        opsOperator: {
          action: "grant",
          email,
          roleKeys: ["platform_admin"],
          enrolmentCode: "A".repeat(32),
        },
      });
      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "refused\n" });
      expect(await countUsers()).toBe(countBefore);
      await expect(findUserByEmail(identitySql, kms, KEY_ARN, { email })).rejects.toThrow(
        IdentityError,
      );
    });
  });
});
