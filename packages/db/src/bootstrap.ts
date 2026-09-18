import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

import { scramSha256Verifier } from "./scram.js";

const LOGIN_ROLES = ["app", "identity", "platform"] as const;
type LoginRole = (typeof LOGIN_ROLES)[number];

const ALL_ROLES = ["migrator", ...LOGIN_ROLES] as const;

const VERIFIER_SAFE = /^[A-Za-z0-9+/=\-:$]+$/;

export async function runBootstrap(sql: Sql): Promise<void> {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../sql/bootstrap.sql");
  const text = readFileSync(file, "utf8");
  await sql.unsafe(text).simple();
  await constrainRoleAttributes(sql);
  await assertRoleAttributes(sql);
}

type RoleAttrs = {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
};

async function constrainRoleAttributes(sql: Sql): Promise<void> {
  const rows = await sql<{ rolsuper: boolean }[]>`
    select rolsuper from pg_roles where rolname = current_user
  `;
  // SUPERUSER and BYPASSRLS can only be changed by a superuser. Docker's
  // bootstrap login is one; the RDS master is rds_superuser, which is not,
  // so those clauses are omitted there and assertRoleAttributes fails closed.
  const privileged = rows[0]?.rolsuper === true ? " NOSUPERUSER NOBYPASSRLS" : "";
  for (const role of ALL_ROLES) {
    const login = role === "migrator" ? "NOLOGIN" : "LOGIN";
    await sql.unsafe(
      `ALTER ROLE ${role} NOINHERIT NOCREATEROLE NOCREATEDB ${login}${privileged}`,
    );
  }
}

async function assertRoleAttributes(sql: Sql): Promise<void> {
  const roles = await sql<RoleAttrs[]>`
    select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
    from pg_roles
    where rolname in ('migrator', 'app', 'identity', 'platform')
  `;
  if (roles.length !== ALL_ROLES.length) {
    throw new Error("bootstrap expected four roles: migrator, app, identity, platform");
  }
  for (const role of roles) {
    const forbidden: string[] = [];
    if (role.rolsuper) forbidden.push("SUPERUSER");
    if (role.rolbypassrls) forbidden.push("BYPASSRLS");
    if (role.rolcreaterole) forbidden.push("CREATEROLE");
    if (role.rolcreatedb) forbidden.push("CREATEDB");
    if (role.rolname === "migrator" && role.rolcanlogin) forbidden.push("LOGIN");
    if (forbidden.length > 0) {
      throw new Error(
        `bootstrap role ${role.rolname} has forbidden attributes: ${forbidden.join(", ")}`,
      );
    }
  }
}

export async function setLoginPasswords(
  sql: Sql,
  passwords: Record<LoginRole, string>,
): Promise<{ verifiers: Record<LoginRole, string> }> {
  const verifiers = {} as Record<LoginRole, string>;
  for (const role of LOGIN_ROLES) {
    const verifier = scramSha256Verifier(passwords[role]);
    if (verifier.includes("'") || !VERIFIER_SAFE.test(verifier)) {
      throw new Error("SCRAM verifier is not safe to embed in ALTER ROLE");
    }
    await sql.unsafe(`ALTER ROLE ${role} PASSWORD '${verifier}'`);
    verifiers[role] = verifier;
  }
  return { verifiers };
}
