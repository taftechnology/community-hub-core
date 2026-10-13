import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createDirectSql, runBootstrap, setLoginPasswords } from "@community-hub/db";

import { readOpsEnv } from "./db-ops-env.js";
import { IMAGE_CERT_PATH } from "./env.js";

type Failure = "env" | "bootstrap" | "alter_role" | "max_connections";

export type DbBootstrapDeps = {
  source: NodeJS.ProcessEnv;
  pem: string;
  connect: typeof createDirectSql;
};

export type DbBootstrapResult = {
  exitCode: 0 | 1;
  stdout: string;
  stderr: "" | `${Failure}\n`;
};

function failed(step: Failure): DbBootstrapResult {
  return { exitCode: 1, stdout: "", stderr: `${step}\n` };
}

export async function runDbBootstrap(deps: DbBootstrapDeps): Promise<DbBootstrapResult> {
  const env = readOpsEnv(deps.source);
  if (env === undefined) {
    return failed("env");
  }
  const { host, port, database, user, master, app, identity, platform } = env;

  let step: Failure = "bootstrap";
  let sql: ReturnType<typeof createDirectSql> | undefined;
  try {
    sql = deps.connect({
      host,
      port,
      database,
      user,
      password: master,
      ca: deps.pem,
    });
    await runBootstrap(sql);
    step = "alter_role";
    await setLoginPasswords(sql, { app, identity, platform });
    step = "max_connections";
    const rows = await sql<{ max_connections: string }[]>`show max_connections`;
    const value = rows[0]?.max_connections;
    if (value === undefined || !/^[0-9]+$/.test(String(value))) {
      return failed("max_connections");
    }
    return { exitCode: 0, stdout: `${value}\n`, stderr: "" };
  } catch {
    return failed(step);
  } finally {
    await sql?.end({ timeout: 1 }).catch(() => undefined);
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void runDbBootstrap({
    source: process.env,
    pem: readFileSync(IMAGE_CERT_PATH, "utf8"),
    connect: createDirectSql,
  }).then((result) => {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  });
}
