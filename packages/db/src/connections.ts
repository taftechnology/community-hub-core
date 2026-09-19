import type { Sql } from "postgres";
import postgres from "postgres";

export function createDirectSql(url: string): Sql {
  return postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
}

export function createPooledSql(url: string): Sql {
  return postgres(url, { prepare: true, max: 4, onnotice: () => undefined });
}

export function createAppSql(url: string): Sql {
  return createPooledSql(url);
}

export function createIdentitySql(url: string): Sql {
  return createPooledSql(url);
}

export function createPlatformSql(url: string): Sql {
  return createPooledSql(url);
}
