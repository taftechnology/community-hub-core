import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

import { scramSha256Verifier } from "./scram.js";

const LOGIN_ROLES = ["app", "identity", "platform"] as const;
type LoginRole = (typeof LOGIN_ROLES)[number];

const VERIFIER_SAFE = /^[A-Za-z0-9+/=\-:$]+$/;

export async function runBootstrap(sql: Sql): Promise<void> {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../sql/bootstrap.sql");
  const text = readFileSync(file, "utf8");
  await sql.unsafe(text).simple();
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
