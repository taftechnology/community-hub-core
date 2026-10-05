import type { Sql } from "postgres";
import postgres from "postgres";

export function createPlaintextDirectSql(url: string): Sql {
  return postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
}

export function createPlaintextAppSql(url: string): Sql {
  return postgres(url, { max: 4, prepare: true, onnotice: () => undefined });
}

export function createPlaintextIdentitySql(url: string): Sql {
  return postgres(url, { max: 4, prepare: true, onnotice: () => undefined });
}

export function createPlaintextPlatformSql(url: string): Sql {
  return postgres(url, { max: 4, prepare: true, onnotice: () => undefined });
}
