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

type Journal = {
  entries: {
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }[];
};

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE = path.join(DIR, "../drizzle");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(path.join(DIR, ".runtime.json"), "utf8")) as Runtime;
}

function findPostgresError(error: unknown): { code?: string; constraint_name?: string } | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof (current as { code?: unknown }).code === "string") {
      return current as { code?: string; constraint_name?: string };
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return null;
}

describe("membership keys migration", () => {
  it("0020 applies over an orphan grant, keeps it, and refuses a new one", async () => {
    const runtime = loadRuntime();
    const database = await freshDatabase(runtime.directUrl);

    const folder = mkdtempSync(path.join(tmpdir(), "hub-db-keys-3a-"));
    const sql = createPlaintextDirectSql(database.url);

    try {
      cpSync(DRIZZLE, folder, { recursive: true });
      const journalPath = path.join(folder, "meta/_journal.json");
      const journal1 = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
      journal1.entries = journal1.entries.filter((entry) => entry.idx <= 19);
      writeFileSync(journalPath, JSON.stringify(journal1, null, 2));

      await applyMigrations({
        sql,
        folder,
        table: "__drizzle_migrations",
      });

      const orgId = newId();
      const commId = newId();
      const userId = newId();
      const grantId = newId();

      await sql.begin(async (tx) => {
        await tx.unsafe("set role migrator");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          insert into app.organisation_role_grants (id, org_id, user_id, role_key)
          values (${grantId}, ${orgId}, ${userId}, 'org_admin')
        `;
      });
      await sql.unsafe("reset role");

      const rawJournal = JSON.parse(
        readFileSync(path.join(DRIZZLE, "meta/_journal.json"), "utf8"),
      ) as Journal;
      const entry20 = rawJournal.entries.find((entry) => entry.idx === 20);
      expect(entry20).toBeDefined();
      rawJournal.entries = rawJournal.entries.filter((entry) => entry.idx <= 20);
      writeFileSync(journalPath, JSON.stringify(rawJournal, null, 2));

      await applyMigrations({
        sql,
        folder,
        table: "__drizzle_migrations",
      });

      const orphanRows = await sql<{ id: string }[]>`
        select id from app.organisation_role_grants where id = ${grantId}
      `;
      expect(orphanRows).toHaveLength(1);

      const constraints = await sql<{ conname: string }[]>`
        select conname from pg_constraint
        where conname in (
          'organisation_role_grants_member_fk',
          'community_role_grants_member_fk',
          'user_links_member_fk'
        )
      `;
      expect(constraints).toHaveLength(3);

      const migrations = await sql<{ id: number }[]>`
        select id from migrator.__drizzle_migrations
      `;
      expect(migrations).toHaveLength(21);

      let insertError: unknown = null;
      const newUser = newId();
      const newGrantId = newId();
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe("set role migrator");
          await tx`select set_config('app.org_id', ${orgId}, true)`;
          await tx`select set_config('app.community_id', ${commId}, true)`;
          await tx`
            insert into app.organisation_role_grants (id, org_id, user_id, role_key)
            values (${newGrantId}, ${orgId}, ${newUser}, 'org_admin')
          `;
        });
      } catch (err) {
        insertError = err;
      } finally {
        await sql.unsafe("reset role");
      }

      const pgError = findPostgresError(insertError);
      expect(pgError?.code).toBe("23503");
      expect(pgError?.constraint_name).toBe("organisation_role_grants_member_fk");
    } finally {
      await sql.end({ timeout: 1 });
      rmSync(folder, { recursive: true, force: true });
      await database.drop();
    }
  }, 180_000);

  it("0020 applies on a fresh database with all three keys present, not validated, on delete restrict", async () => {
    const runtime = loadRuntime();
    const database = await freshDatabase(runtime.directUrl);

    const folder = mkdtempSync(path.join(tmpdir(), "hub-db-keys-3b-"));
    const sql = createPlaintextDirectSql(database.url);

    try {
      cpSync(DRIZZLE, folder, { recursive: true });
      const journalPath = path.join(folder, "meta/_journal.json");
      const rawJournal = JSON.parse(
        readFileSync(path.join(DRIZZLE, "meta/_journal.json"), "utf8"),
      ) as Journal;
      const entry20 = rawJournal.entries.find((entry) => entry.idx === 20);
      expect(entry20).toBeDefined();
      rawJournal.entries = rawJournal.entries.filter((entry) => entry.idx <= 20);
      writeFileSync(journalPath, JSON.stringify(rawJournal, null, 2));

      await applyMigrations({
        sql,
        folder,
        table: "__drizzle_migrations",
      });

      const constraints = await sql<
        {
          conname: string;
          convalidated: boolean;
          confdeltype: string;
        }[]
      >`
        select conname, convalidated, confdeltype
        from pg_constraint
        where conname in (
          'organisation_role_grants_member_fk',
          'community_role_grants_member_fk',
          'user_links_member_fk'
        )
        order by conname
      `;

      expect(constraints).toHaveLength(3);
      for (const c of constraints) {
        expect(c.convalidated).toBe(false);
        expect(c.confdeltype).toBe("r");
      }
    } finally {
      await sql.end({ timeout: 1 });
      rmSync(folder, { recursive: true, force: true });
      await database.drop();
    }
  }, 180_000);
});
