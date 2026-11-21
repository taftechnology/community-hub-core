import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlaintextDirectSql } from "../src/plaintext.js";
import { applyMigrations } from "../src/migrate.js";
import { freshDatabase, type FreshDatabase } from "./fixtures/database-fixture.js";
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

function toIso(dateOrString: Date | string): string {
  return new Date(dateOrString).toISOString();
}

function toEpoch(dateOrString: Date | string): number {
  return new Date(dateOrString).getTime();
}

describe("persons status, source and created_at migration 0021", () => {
  let database: FreshDatabase;
  let sql: ReturnType<typeof createPlaintextDirectSql>;
  let folder: string;

  const orgId = newId();
  const commA = newId();
  const commB = newId();

  const personA_created = newId();
  const personA_tagged = newId();
  const personA_none = newId();

  const personB_created = newId();
  const personB_tagged = newId();
  const personB_none = newId();

  const tTaggedEarlierA = new Date("2026-01-01T10:00:00.000Z");
  const tCreatedA = new Date("2026-01-05T10:00:00.000Z");
  const tTaggedA2 = new Date("2026-01-10T10:00:00.000Z");

  const tTaggedEarlierB = new Date("2026-02-01T10:00:00.000Z");
  const tCreatedB = new Date("2026-02-05T10:00:00.000Z");
  const tTaggedB2 = new Date("2026-02-10T10:00:00.000Z");

  let beforeMigrationTime: Date;
  let afterMigrationTime: Date;

  beforeAll(async () => {
    const runtime = loadRuntime();
    database = await freshDatabase(runtime.directUrl);
    sql = createPlaintextDirectSql(database.url);
    folder = mkdtempSync(path.join(tmpdir(), "hub-db-status-source-"));

    // Step 1: Copy drizzle into folder with journal entries idx 0 to 20 only
    cpSync(DRIZZLE, folder, { recursive: true });
    const journalPath = path.join(folder, "meta/_journal.json");
    const journal1 = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
    journal1.entries = journal1.entries.filter((entry) => entry.idx <= 20);
    writeFileSync(journalPath, JSON.stringify(journal1, null, 2));

    await applyMigrations({
      sql,
      folder,
      table: "__drizzle_migrations",
    });

    // Step 2: Seed platform organisations and communities as migrator
    await sql.unsafe("set role migrator");
    await sql`
      insert into platform.organisations (id, slug, region, kind) values
        (${orgId}, ${`org-${orgId}`}, 'au', 'implicit')
    `;
    await sql`
      insert into platform.communities (id, organisation_id, slug, region) values
        (${commA}, ${orgId}, ${`comm-${commA}`}, 'au'),
        (${commB}, ${orgId}, ${`comm-${commB}`}, 'au')
    `;

    // Seed community A inside a transaction with per-community set_config(..., true)
    await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commA}, true)`;

      await tx`
        insert into app.persons (id, org_id, community_id, version, is_minor, age_basis, given_name, family_name) values
          (${personA_created}, ${orgId}, ${commA}, 1, false, 'declared_adult', 'Alice', 'Created'),
          (${personA_tagged}, ${orgId}, ${commA}, 1, false, 'declared_adult', 'Arthur', 'Tagged'),
          (${personA_none}, ${orgId}, ${commA}, 1, false, 'declared_adult', 'Aaron', 'None')
      `;

      await tx`
        insert into app.person_activity (id, org_id, community_id, person_id, kind, occurred_at) values
          (${newId()}, ${orgId}, ${commA}, ${personA_created}, 'tagged', ${tTaggedEarlierA.toISOString()}),
          (${newId()}, ${orgId}, ${commA}, ${personA_created}, 'created', ${tCreatedA.toISOString()}),
          (${newId()}, ${orgId}, ${commA}, ${personA_tagged}, 'tagged', ${tTaggedA2.toISOString()})
      `;
    });

    // Seed community B inside a transaction with per-community set_config(..., true)
    await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commB}, true)`;

      await tx`
        insert into app.persons (id, org_id, community_id, version, is_minor, age_basis, given_name, family_name) values
          (${personB_created}, ${orgId}, ${commB}, 1, false, 'declared_adult', 'Bob', 'Created'),
          (${personB_tagged}, ${orgId}, ${commB}, 1, false, 'declared_adult', 'Betty', 'Tagged'),
          (${personB_none}, ${orgId}, ${commB}, 1, false, 'declared_adult', 'Brian', 'None')
      `;

      await tx`
        insert into app.person_activity (id, org_id, community_id, person_id, kind, occurred_at) values
          (${newId()}, ${orgId}, ${commB}, ${personB_created}, 'tagged', ${tTaggedEarlierB.toISOString()}),
          (${newId()}, ${orgId}, ${commB}, ${personB_created}, 'created', ${tCreatedB.toISOString()}),
          (${newId()}, ${orgId}, ${commB}, ${personB_tagged}, 'tagged', ${tTaggedB2.toISOString()})
      `;
    });

    await sql.unsafe("reset role");

    // Step 3: Copy full drizzle folder up to idx 21 and apply migration 0021
    cpSync(DRIZZLE, folder, { recursive: true });
    const rawJournal = JSON.parse(
      readFileSync(path.join(DRIZZLE, "meta/_journal.json"), "utf8"),
    ) as Journal;
    const entry21 = rawJournal.entries.find((entry) => entry.idx === 21);
    expect(entry21, "migration 0021 entry exists in journal").toBeDefined();

    rawJournal.entries = rawJournal.entries.filter((entry) => entry.idx <= 21);
    writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify(rawJournal, null, 2));

    const [beforeDb] = await sql<{ now: Date }[]>`select now() as now`;
    beforeMigrationTime = new Date(beforeDb.now);
    await applyMigrations({
      sql,
      folder,
      table: "__drizzle_migrations",
    });
    const [afterDb] = await sql<{ now: Date }[]>`select now() as now`;
    afterMigrationTime = new Date(afterDb.now);
  }, 180_000);

  afterAll(async () => {
    if (sql) {
      await sql.end({ timeout: 1 });
    }
    if (folder) {
      rmSync(folder, { recursive: true, force: true });
    }
    if (database) {
      await database.drop();
    }
  }, 120_000);

  it("migration 0021: backfills created_at in two communities of one organisation", async () => {
    type PersonRow = {
      id: string;
      status: string;
      source: string;
      created_at: Date | string;
    };

    // Comm A query
    const rowsA = await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commA}, true)`;
      return tx<PersonRow[]>`
        select id, status, source, created_at
        from app.persons
        where id in (${personA_created}, ${personA_tagged}, ${personA_none})
      `;
    });

    const mapA = new Map(rowsA.map((r) => [r.id, r]));
    const pACreated = mapA.get(personA_created)!;
    const pATagged = mapA.get(personA_tagged)!;
    const pANone = mapA.get(personA_none)!;

    expect(pACreated).toBeDefined();
    expect(toIso(pACreated.created_at)).toBe(tCreatedA.toISOString());
    expect(pACreated.status).toBe("active");
    expect(pACreated.source).toBe("manual");

    expect(pATagged).toBeDefined();
    expect(toIso(pATagged.created_at)).toBe(tTaggedA2.toISOString());
    expect(pATagged.status).toBe("active");
    expect(pATagged.source).toBe("manual");

    expect(pANone).toBeDefined();
    expect(pANone.status).toBe("active");
    expect(pANone.source).toBe("manual");
    expect(toEpoch(pANone.created_at)).toBeGreaterThanOrEqual(beforeMigrationTime.getTime() - 2000);
    expect(toEpoch(pANone.created_at)).toBeLessThanOrEqual(afterMigrationTime.getTime() + 2000);

    // Comm B query
    const rowsB = await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commB}, true)`;
      return tx<PersonRow[]>`
        select id, status, source, created_at
        from app.persons
        where id in (${personB_created}, ${personB_tagged}, ${personB_none})
      `;
    });

    const mapB = new Map(rowsB.map((r) => [r.id, r]));
    const pBCreated = mapB.get(personB_created)!;
    const pBTagged = mapB.get(personB_tagged)!;
    const pBNone = mapB.get(personB_none)!;

    expect(pBCreated).toBeDefined();
    expect(toIso(pBCreated.created_at)).toBe(tCreatedB.toISOString());
    expect(pBCreated.status).toBe("active");
    expect(pBCreated.source).toBe("manual");

    expect(pBTagged).toBeDefined();
    expect(toIso(pBTagged.created_at)).toBe(tTaggedB2.toISOString());
    expect(pBTagged.status).toBe("active");
    expect(pBTagged.source).toBe("manual");

    expect(pBNone).toBeDefined();
    expect(pBNone.status).toBe("active");
    expect(pBNone.source).toBe("manual");
    expect(toEpoch(pBNone.created_at)).toBeGreaterThanOrEqual(beforeMigrationTime.getTime() - 2000);
    expect(toEpoch(pBNone.created_at)).toBeLessThanOrEqual(afterMigrationTime.getTime() + 2000);
  });

  it("migration 0021: a person whose only activity is not kind created gets that activity's time", async () => {
    type PersonRow = {
      id: string;
      created_at: Date | string;
    };

    const [rowA] = await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commA}, true)`;
      return tx<PersonRow[]>`
        select id, created_at
        from app.persons
        where id = ${personA_tagged}
      `;
    });

    const [rowB] = await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commB}, true)`;
      return tx<PersonRow[]>`
        select id, created_at
        from app.persons
        where id = ${personB_tagged}
      `;
    });

    expect(rowA).toBeDefined();
    expect(toIso(rowA.created_at)).toBe(tTaggedA2.toISOString());
    expect(rowB).toBeDefined();
    expect(toIso(rowB.created_at)).toBe(tTaggedB2.toISOString());
  });

  it("migration 0021: applies defaults on insert", async () => {
    const newPersonId = newId();
    const insertTime = new Date();

    await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commA}, true)`;
      await tx`
        insert into app.persons (id, org_id, community_id, version, is_minor, age_basis, given_name, family_name)
        values (${newPersonId}, ${orgId}, ${commA}, 1, false, 'declared_adult', 'Default', 'User')
      `;
    });

    const [row] = await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commA}, true)`;
      return tx<{ status: string; source: string; created_at: Date | string }[]>`
        select status, source, created_at
        from app.persons
        where id = ${newPersonId}
      `;
    });

    expect(row).toBeDefined();
    expect(row?.status).toBe("active");
    expect(row?.source).toBe("manual");
    expect(toEpoch(row.created_at)).toBeGreaterThanOrEqual(insertTime.getTime() - 5000);
  });

  it("migration 0021: refuses a status outside active and inactive", async () => {
    let insertError: unknown = null;
    const testPersonId = newId();

    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("set role migrator");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commA}, true)`;
        await tx`
          insert into app.persons (id, org_id, community_id, version, is_minor, age_basis, given_name, family_name, status)
          values (${testPersonId}, ${orgId}, ${commA}, 1, false, 'declared_adult', 'Bad', 'Status', 'invalid_status')
        `;
      });
    } catch (err) {
      insertError = err;
    }

    const pgError = findPostgresError(insertError);
    expect(pgError?.code).toBe("23514");
    expect(pgError?.constraint_name).toBe("persons_status_check");
  });

  it("migration 0021: refuses a source outside the eleven keys", async () => {
    let insertError: unknown = null;
    const testPersonId = newId();

    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("set role migrator");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commA}, true)`;
        await tx`
          insert into app.persons (id, org_id, community_id, version, is_minor, age_basis, given_name, family_name, source)
          values (${testPersonId}, ${orgId}, ${commA}, 1, false, 'declared_adult', 'Bad', 'Source', 'not_a_valid_source')
        `;
      });
    } catch (err) {
      insertError = err;
    }

    const pgError = findPostgresError(insertError);
    expect(pgError?.code).toBe("23514");
    expect(pgError?.constraint_name).toBe("persons_source_check");
  });

  it("migration 0021: leaves no tenant setting on the session", async () => {
    const [row] = await sql<{ org_id: string | null; community_id: string | null }[]>`
      select
        current_setting('app.org_id', true) as org_id,
        current_setting('app.community_id', true) as community_id
    `;
    expect(row.org_id ?? "").toBe("");
    expect(row.community_id ?? "").toBe("");
  });
});
