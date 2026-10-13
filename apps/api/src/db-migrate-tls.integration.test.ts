import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDirectSql, runBootstrap } from "@community-hub/db";
import { createPlaintextDirectSql } from "@community-hub/db/plaintext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TLS_SERVER_NAME,
  createTlsCerts,
  startTlsPostgres,
  type TlsCerts,
  type TlsPostgres,
} from "../../../packages/db/test/fixtures/tls-fixture.js";
import { runDbBootstrap } from "./db-bootstrap.js";
import { runDbMigrate, type DbMigrateDeps, type DbMigrateResult } from "./db-migrate.js";

const DB_PACKAGE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db",
);
const journal = JSON.parse(
  readFileSync(path.join(DB_PACKAGE, "drizzle/meta/_journal.json"), "utf8"),
) as { entries: { tag: string }[] };
const TAGS = journal.entries.map((entry) => entry.tag);
const TOTAL = TAGS.length;
const ALL_TAGS = TAGS.map((tag) => `applied ${tag}\n`).join("");

const DATABASE = "migrate_target";
const MASTER_USER = "migrate_master";
const SUPERUSER = "hub";
const secret = () => randomBytes(18).toString("base64url");
const SUPERUSER_PASSWORD = secret();
const PASSWORDS = {
  master: secret(),
  app: secret(),
  identity: secret(),
  platform: secret(),
};

let certs: TlsCerts | undefined;
let server: TlsPostgres | undefined;

function source(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PGHOST: "127.0.0.1",
    PGPORT: String(server?.port),
    PGDATABASE: DATABASE,
    PGUSER: MASTER_USER,
    PGPASSWORD_MASTER: PASSWORDS.master,
    PGPASSWORD_APP: PASSWORDS.app,
    PGPASSWORD_IDENTITY: PASSWORDS.identity,
    PGPASSWORD_PLATFORM: PASSWORDS.platform,
    ...overrides,
  };
}

// createDirectSql still verifies the certificate against the test CA. The
// command has no servername input, and the host here is an IP address.
const connect: DbMigrateDeps["connect"] = (target) =>
  createDirectSql({ ...target, servername: TLS_SERVER_NAME });

function pem(): string {
  if (certs === undefined) {
    throw new Error("certificates were not created");
  }
  return certs.signingCa;
}

function command(overrides: NodeJS.ProcessEnv = {}): Promise<DbMigrateResult> {
  return runDbMigrate({ source: source(overrides), pem: pem(), connect });
}

async function asSuperuser<T>(
  body: (sql: ReturnType<typeof createPlaintextDirectSql>) => Promise<T>,
): Promise<T> {
  const sql = createPlaintextDirectSql(
    `postgres://${SUPERUSER}:${encodeURIComponent(SUPERUSER_PASSWORD)}@127.0.0.1:${server?.port}/${DATABASE}`,
  );
  try {
    return await body(sql);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** Roles, schemas and tables that the command must not have created. */
async function created(sql: ReturnType<typeof createPlaintextDirectSql>): Promise<{
  roles: string[];
  schemas: string[];
  tables: number;
}> {
  const roles = await sql<{ rolname: string }[]>`
    select rolname from pg_roles
    where rolname in ('migrator', 'app', 'identity', 'platform') order by rolname
  `;
  const schemas = await sql<{ nspname: string }[]>`
    select nspname from pg_namespace
    where nspname in ('migrator', 'app', 'identity', 'platform') order by nspname
  `;
  const tables = await sql<{ n: string }[]>`
    select count(*)::text as n from pg_tables
    where schemaname not in ('pg_catalog', 'information_schema')
  `;
  return {
    roles: roles.map((row) => row.rolname),
    schemas: schemas.map((row) => row.nspname),
    tables: Number(tables[0]?.n),
  };
}

beforeAll(async () => {
  certs = createTlsCerts();
  server = await startTlsPostgres({
    certDir: certs.dir,
    superuser: SUPERUSER,
    password: SUPERUSER_PASSWORD,
    database: "hub",
    namePrefix: "ch-db-migrate-tls-",
  });
  // The stand-in for the RDS master: not a superuser, no rds_superuser, owns its database.
  const admin = createPlaintextDirectSql(
    `postgres://${SUPERUSER}:${encodeURIComponent(SUPERUSER_PASSWORD)}@127.0.0.1:${server.port}/hub`,
  );
  try {
    await admin
      .unsafe(`create role ${MASTER_USER} login createrole createdb password '${PASSWORDS.master}'`)
      .simple();
    await admin.unsafe(`create database ${DATABASE} owner ${MASTER_USER}`).simple();
  } finally {
    await admin.end({ timeout: 1 });
  }
}, 120_000);

afterAll(() => {
  server?.stop();
  certs?.cleanup();
}, 30_000);

describe("db-migrate over TLS as a non-superuser master", () => {
  it("1. refuses on an empty cluster and creates nothing", async () => {
    const result = await command();
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "not_bootstrapped\n" });
    expect(await asSuperuser(created)).toEqual({ roles: [], schemas: [], tables: 0 });
  }, 30_000);

  it("2. refuses when the roles exist with no passwords and creates no schema or table", async () => {
    const master = createDirectSql({
      host: "127.0.0.1",
      port: Number(server?.port),
      database: DATABASE,
      user: MASTER_USER,
      password: PASSWORDS.master,
      ca: pem(),
      servername: TLS_SERVER_NAME,
    });
    try {
      await runBootstrap(master);
    } finally {
      await master.end({ timeout: 1 });
    }

    const result = await command();
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "not_bootstrapped\n" });
    const after = await asSuperuser(created);
    expect(after.schemas).toEqual(["migrator"]);
    expect(after.tables).toBe(0);
  }, 30_000);

  it("3. refuses when one role has a wrong password", async () => {
    const bootstrap = await runDbBootstrap({ source: source(), pem: pem(), connect });
    expect(bootstrap.exitCode).toBe(0);

    const result = await command({ PGPASSWORD_IDENTITY: secret() });
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "not_bootstrapped\n" });
    const tables = await asSuperuser(
      (sql) => sql<{ n: string }[]>`
        select count(*)::text as n from pg_tables where schemaname in ('app', 'identity', 'platform')
      `,
    );
    expect(tables[0]?.n).toBe("0");
  }, 30_000);

  it("4. reports a wrong master password as connect 28P01", async () => {
    const result = await command({ PGPASSWORD_MASTER: secret() });
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "connect 28P01\n" });
  }, 30_000);

  it("5. applies every migration, running bootstrap.sql again as a non-superuser", async () => {
    const result = await command();
    expect(result).toEqual({
      exitCode: 0,
      stdout: `${ALL_TAGS}done applied=${TOTAL} total=${TOTAL}\n`,
      stderr: "",
    });
  }, 30_000);

  it("6. applies nothing on a second run", async () => {
    const result = await command();
    expect(result).toEqual({
      exitCode: 0,
      stdout: `done applied=0 total=${TOTAL}\n`,
      stderr: "",
    });
  }, 30_000);
});
