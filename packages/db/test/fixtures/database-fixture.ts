import { randomBytes } from "node:crypto";

import { createPlaintextDirectSql } from "../../src/plaintext.js";

export type FreshDatabase = {
  name: string;
  url: string;
  drop(): Promise<void>;
};

/**
 * Creates a new database on the shared test cluster and returns a URL for it.
 * Roles are cluster-wide, so the caller drops the database and never a role.
 */
export async function freshDatabase(directUrl: string): Promise<FreshDatabase> {
  const name = `hub_t_${randomBytes(4).toString("hex")}`;
  const admin = createPlaintextDirectSql(directUrl);
  try {
    await admin.unsafe(`create database ${name}`).simple();
  } finally {
    await admin.end({ timeout: 1 });
  }
  const target = new URL(directUrl);
  target.pathname = `/${name}`;
  return {
    name,
    url: target.toString(),
    async drop() {
      const sql = createPlaintextDirectSql(directUrl);
      try {
        await sql.unsafe(`drop database if exists ${name} with (force)`).simple();
      } finally {
        await sql.end({ timeout: 1 });
      }
    },
  };
}
