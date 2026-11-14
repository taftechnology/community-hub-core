import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createPlaintextDirectSql } from "../src/plaintext.js";
import { applyMigrations } from "../src/migrate.js";
import { freshDatabase } from "./fixtures/database-fixture.js";
import { newId } from "../src/ids.js";

type Runtime = {
  directUrl: string;
};

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE = path.join(DIR, "../drizzle");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(path.join(DIR, ".runtime.json"), "utf8")) as Runtime;
}

describe("membership backfill migration", () => {
  it("backfills memberships from grants and links, scoping per community and taking only real users (pins 3, 4, 5)", async () => {
    const runtime = loadRuntime();
    const database = await freshDatabase(runtime.directUrl);

    const folder1 = mkdtempSync(path.join(tmpdir(), "hub-db-backfill-1-"));
    const folder2 = mkdtempSync(path.join(tmpdir(), "hub-db-backfill-2-"));

    const sql = createPlaintextDirectSql(database.url);

    try {
      // Step 1: Copy drizzle into folder1 with journal entries idx 0 to 18 only
      cpSync(DRIZZLE, folder1, { recursive: true });
      const journal1Path = path.join(folder1, "meta/_journal.json");
      const journal1 = JSON.parse(readFileSync(journal1Path, "utf8")) as {
        entries: {
          idx: number;
          version: string;
          when: number;
          tag: string;
          breakpoints: boolean;
        }[];
      };
      journal1.entries = journal1.entries.filter((entry) => entry.idx <= 18);
      writeFileSync(journal1Path, JSON.stringify(journal1, null, 2));

      // Apply migrations up to 0018
      await applyMigrations({
        sql,
        folder: folder1,
        table: "__drizzle_migrations",
      });

      // Step 2: Seed as migrator
      const orgA = newId();
      const orgB = newId();
      const commA1 = newId();
      const commA2 = newId();
      const commB1 = newId();

      const user1 = newId();
      const user2 = newId();
      const user3 = newId();
      const user4 = newId();
      const user5 = newId();
      const userNoIdentity = newId();

      await sql.unsafe("set role migrator");

      // Platform organisations and communities
      await sql`
        insert into platform.organisations (id, slug, region, kind) values
          (${orgA}, ${`org-${orgA}`}, 'au', 'implicit'),
          (${orgB}, ${`org-${orgB}`}, 'au', 'implicit')
      `;
      await sql`
        insert into platform.communities (id, organisation_id, slug, region) values
          (${commA1}, ${orgA}, ${`comm-${commA1}`}, 'au'),
          (${commA2}, ${orgA}, ${`comm-${commA2}`}, 'au'),
          (${commB1}, ${orgB}, ${`comm-${commB1}`}, 'au')
      `;

      // Identity users: real rows for user1..user5, none for userNoIdentity (pin 5)
      for (const [userId, idx] of [
        [user1, 1],
        [user2, 2],
        [user3, 3],
        [user4, 4],
        [user5, 5],
      ] as const) {
        const bidx = Buffer.alloc(32);
        bidx.writeUInt32BE(idx, 0);
        await sql`
          insert into identity.users (id, region, email, email_bidx)
          values (${userId}, 'au', ${Buffer.from(`user${idx}@example.test`)}, ${bidx})
        `;
      }

      // Community A1 transaction (one transaction per community, with set_config(..., true))
      await sql.begin(async (tx) => {
        await tx.unsafe("set role migrator");
        await tx`select set_config('app.org_id', ${orgA}, true)`;
        await tx`select set_config('app.community_id', ${commA1}, true)`;

        // user1: org role grant
        await tx`
          insert into app.organisation_role_grants (id, org_id, user_id, role_key)
          values (${newId()}, ${orgA}, ${user1}, 'org_owner')
        `;

        // user2: community role grant in comm A1
        await tx`
          insert into app.community_role_grants (id, org_id, community_id, user_id, role_key)
          values (${newId()}, ${orgA}, ${commA1}, ${user2}, 'staff')
        `;

        // user4: multi-org user - community grant in comm A1
        await tx`
          insert into app.community_role_grants (id, org_id, community_id, user_id, role_key)
          values (${newId()}, ${orgA}, ${commA1}, ${user4}, 'community_admin')
        `;

        // userNoIdentity: community grant in comm A1 (no identity row)
        await tx`
          insert into app.community_role_grants (id, org_id, community_id, user_id, role_key)
          values (${newId()}, ${orgA}, ${commA1}, ${userNoIdentity}, 'staff')
        `;
      });

      // Community A2 transaction
      await sql.begin(async (tx) => {
        await tx.unsafe("set role migrator");
        await tx`select set_config('app.org_id', ${orgA}, true)`;
        await tx`select set_config('app.community_id', ${commA2}, true)`;

        // user3: user link in comm A2 (requires a person row in comm A2)
        const personId = newId();
        await tx`
          insert into app.persons (id, org_id, community_id, version, is_minor, age_basis, given_name, family_name)
          values (${personId}, ${orgA}, ${commA2}, 1, false, 'declared_adult', 'Link', 'Target')
        `;
        await tx`
          insert into app.user_links (id, org_id, community_id, user_id, person_id)
          values (${newId()}, ${orgA}, ${commA2}, ${user3}, ${personId})
        `;
      });

      // Community B1 transaction
      await sql.begin(async (tx) => {
        await tx.unsafe("set role migrator");
        await tx`select set_config('app.org_id', ${orgB}, true)`;
        await tx`select set_config('app.community_id', ${commB1}, true)`;

        // user4: multi-org user - org role grant in org B
        await tx`
          insert into app.organisation_role_grants (id, org_id, user_id, role_key)
          values (${newId()}, ${orgB}, ${user4}, 'org_admin')
        `;

        // user5: community role grant in comm B1
        await tx`
          insert into app.community_role_grants (id, org_id, community_id, user_id, role_key)
          values (${newId()}, ${orgB}, ${commB1}, ${user5}, 'member')
        `;
      });

      await sql.unsafe("reset role");

      // Step 3: Copy full folder into folder2, add 0020_probe.sql and journal entry idx 20
      cpSync(DRIZZLE, folder2, { recursive: true });
      const probeSql = `DO $$ BEGIN IF coalesce(current_setting('app.org_id', true), '') <> '' OR coalesce(current_setting('app.community_id', true), '') <> '' THEN RAISE EXCEPTION 'scope leaked'; END IF; END $$;`;
      writeFileSync(path.join(folder2, "0020_probe.sql"), probeSql);

      const journal2Path = path.join(folder2, "meta/_journal.json");
      const journal2 = JSON.parse(readFileSync(journal2Path, "utf8")) as {
        entries: {
          idx: number;
          version: string;
          when: number;
          tag: string;
          breakpoints: boolean;
        }[];
      };
      const entry0019 = journal2.entries.find((e) => e.idx === 19);
      expect(entry0019).toBeDefined();

      journal2.entries.push({
        idx: 20,
        version: "7",
        when: (entry0019?.when ?? Date.now()) + 1000,
        tag: "0020_probe",
        breakpoints: true,
      });
      writeFileSync(journal2Path, JSON.stringify(journal2, null, 2));

      // Apply migrations (will apply 0019 and 0020_probe)
      const report = await applyMigrations({
        sql,
        folder: folder2,
        table: "__drizzle_migrations",
      });

      expect(report.applied).toContain("0020_probe");

      // Step 4: Assert exact set of (org_id, user_id, source) memberships
      const memberships = await sql<{ org_id: string; user_id: string; source: string }[]>`
        select org_id, user_id, source
        from app.organisation_members
        order by org_id, user_id
      `;

      const expected = [
        { org_id: orgA, user_id: user1, source: "backfill" },
        { org_id: orgA, user_id: user2, source: "backfill" },
        { org_id: orgA, user_id: user3, source: "backfill" },
        { org_id: orgA, user_id: user4, source: "backfill" },
        { org_id: orgB, user_id: user4, source: "backfill" },
        { org_id: orgB, user_id: user5, source: "backfill" },
      ].sort((a, b) => (a.org_id + a.user_id).localeCompare(b.org_id + b.user_id));

      expect(memberships).toEqual(expected);
    } finally {
      await sql.end({ timeout: 1 });
      rmSync(folder1, { recursive: true, force: true });
      rmSync(folder2, { recursive: true, force: true });
      await database.drop();
    }
  }, 180_000);
});
