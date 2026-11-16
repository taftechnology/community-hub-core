import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blindIndex, decrypt, deriveKeys, unwrapKmsRoot } from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";

import { ensureIdentityKey } from "../public/index.js";
import { insertIdentityUser } from "./identity-user.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const CONTEXT = { key_kind: "identity", region: "au", key_version: "1" } as const;

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

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
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

describe("identity key and email", () => {
  it("stores one region key and an encrypted email looked up by blind index", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    const kms = createLocalKmsPort();
    try {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const keys = await sql<{ n: number; region: string; key_version: string }[]>`
        select count(*)::int as n, region, key_version
        from identity.identity_keys
        group by region, key_version
      `;
      expect(keys).toEqual([{ n: 1, region: "au", key_version: "1" }]);

      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });
      const stored = await sql<{ id: string; wrapped: Uint8Array }[]>`
        select id, wrapped from identity.identity_keys where region = 'au'
      `;
      const row = stored[0];
      expect(row).toBeDefined();
      const hkdfKey = await unwrapKmsRoot(kms, KEY_ARN, row?.wrapped ?? new Uint8Array(), CONTEXT);
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
      expect(users[0]?.id).toBe(created.userId);
      const plaintext = await decrypt(users[0]?.email as never, () => enc, {
        tag: "chub/field-identity/v1",
        label: "identity.users.email",
        rowId: uuidToBytes(created.userId),
        region: "au",
      });
      expect(new TextDecoder().decode(plaintext)).toBe("ada@example.com");
    } finally {
      await sql.end({ timeout: 1 });
    }

    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      for (const role of ["app", "platform"] as const) {
        const privileges = await direct<{ schema_usage: boolean; users_select: boolean }[]>`
          select
            has_schema_privilege(${role}, 'identity', 'USAGE') as schema_usage,
            has_table_privilege(${role}, 'identity.users', 'SELECT') as users_select
        `;
        expect(privileges).toEqual([{ schema_usage: false, users_select: false }]);
      }
    } finally {
      await direct.end({ timeout: 1 });
    }

    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    try {
      await expect(app`select * from identity.users`).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end({ timeout: 1 });
    }

    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    try {
      await expect(platform`select * from identity.users`).rejects.toMatchObject({ code: "42501" });
    } finally {
      await platform.end({ timeout: 1 });
    }
  });

  it("enforces table and column privileges on invitation_emails (pin 2b)", async () => {
    const runtime = loadRuntime();
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const [tablePrivs] = await direct<
        {
          can_select: boolean;
          can_insert: boolean;
          can_delete: boolean;
          can_update: boolean;
          can_truncate: boolean;
        }[]
      >`
        select
          has_table_privilege('identity', 'identity.invitation_emails', 'SELECT') as can_select,
          has_table_privilege('identity', 'identity.invitation_emails', 'INSERT') as can_insert,
          has_table_privilege('identity', 'identity.invitation_emails', 'DELETE') as can_delete,
          has_table_privilege('identity', 'identity.invitation_emails', 'UPDATE') as can_update,
          has_table_privilege('identity', 'identity.invitation_emails', 'TRUNCATE') as can_truncate
      `;
      expect(tablePrivs).toEqual({
        can_select: true,
        can_insert: true,
        can_delete: true,
        can_update: false,
        can_truncate: false,
      });

      const allowedColumns = [
        "email",
        "email_bidx",
        "dedupe_key",
        "expires_at",
        "closed_at",
      ] as const;

      const forbiddenColumns = ["invitation_id", "region", "created_at"] as const;

      for (const col of allowedColumns) {
        const [row] = await direct<{ granted: boolean }[]>`
          select has_column_privilege('identity', 'identity.invitation_emails', ${col}, 'UPDATE') as granted
        `;
        expect(
          row?.granted,
          `expected column invitation_emails.${col} to be updatable by identity`,
        ).toBe(true);
      }

      for (const col of forbiddenColumns) {
        const [row] = await direct<{ granted: boolean }[]>`
          select has_column_privilege('identity', 'identity.invitation_emails', ${col}, 'UPDATE') as granted
        `;
        expect(
          row?.granted,
          `expected column invitation_emails.${col} NOT to be updatable by identity`,
        ).toBe(false);
      }

      const updatableRows = await direct<{ attname: string }[]>`
        select attname
        from pg_attribute
        where attrelid = 'identity.invitation_emails'::regclass
          and attnum > 0
          and not attisdropped
          and has_column_privilege('identity', 'identity.invitation_emails', attname, 'UPDATE')
        order by attname
      `;
      const updatableColumns = updatableRows.map((r) => r.attname);
      expect(updatableColumns).toEqual([...allowedColumns].sort());

      for (const role of ["app", "platform"] as const) {
        const [privs] = await direct<
          {
            can_select: boolean;
            can_insert: boolean;
            can_update: boolean;
            can_delete: boolean;
            can_truncate: boolean;
          }[]
        >`
          select
            has_table_privilege(${role}, 'identity.invitation_emails', 'SELECT') as can_select,
            has_table_privilege(${role}, 'identity.invitation_emails', 'INSERT') as can_insert,
            has_table_privilege(${role}, 'identity.invitation_emails', 'UPDATE') as can_update,
            has_table_privilege(${role}, 'identity.invitation_emails', 'DELETE') as can_delete,
            has_table_privilege(${role}, 'identity.invitation_emails', 'TRUNCATE') as can_truncate
        `;
        expect(privs).toEqual({
          can_select: false,
          can_insert: false,
          can_update: false,
          can_delete: false,
          can_truncate: false,
        });
      }
    } finally {
      await direct.end({ timeout: 1 });
    }

    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    try {
      await expect(app`select * from identity.invitation_emails`).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await app.end({ timeout: 1 });
    }

    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    try {
      await expect(platform`select * from identity.invitation_emails`).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await platform.end({ timeout: 1 });
    }
  });
});
