import { isIP } from "node:net";
import type { Sql } from "postgres";
import postgres from "postgres";

export type SqlTarget = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ca: string;
  servername?: string;
};

function open(target: SqlTarget, max: number, prepare: boolean): Sql {
  let servername = target.servername;
  if (servername === undefined) {
    if (isIP(target.host) !== 0) {
      throw new Error("servername is required when host is an IP address");
    }
    servername = target.host;
  }
  return postgres({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    max,
    prepare,
    onnotice: () => undefined,
    ssl: {
      ca: target.ca,
      rejectUnauthorized: true,
      servername,
    },
  });
}

export function createDirectSql(target: SqlTarget): Sql {
  return open(target, 1, false);
}

export function createAppSql(target: SqlTarget): Sql {
  return open(target, 4, true);
}

export function createIdentitySql(target: SqlTarget): Sql {
  return open(target, 4, true);
}

export function createPlatformSql(target: SqlTarget): Sql {
  return open(target, 4, true);
}
