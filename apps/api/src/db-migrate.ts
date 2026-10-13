import { pathToFileURL } from "node:url";

import { applyProductMigrations, createDirectSql } from "@community-hub/db";

import { loadImageCa, readOpsEnv } from "./db-ops-env.js";
import { failureLine, sqlstate } from "./db-ops-error.js";

export type Stage = "env" | "connect" | "not_bootstrapped" | "migrate";

/** The stage the run has reached, so the backstop can name it without reading an error. */
export type Progress = { stage: Stage };

export type DbMigrateDeps = {
  source: NodeJS.ProcessEnv;
  /** undefined when the image's CA bundle could not be read. */
  pem: string | undefined;
  connect: typeof createDirectSql;
};

export type DbMigrateResult = {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
};

type Connection = ReturnType<typeof createDirectSql>;

const LOGIN_ROLES = ["app", "identity", "platform"] as const;
const REFUSED = new Set(["28P01", "28000"]);

function failed(stderr: string): DbMigrateResult {
  return { exitCode: 1, stdout: "", stderr };
}

async function close(sql: Connection | undefined): Promise<void> {
  try {
    await sql?.end({ timeout: 1 });
  } catch {
    // A failed close changes no result.
  }
}

/** True when the server refuses this role's login. Any other failure is thrown to the caller. */
async function loginRefused(open: () => Connection): Promise<boolean> {
  let sql: Connection | undefined;
  try {
    sql = open();
    await sql`select 1`;
    return false;
  } catch (error) {
    const code = sqlstate(error);
    if (code !== undefined && REFUSED.has(code)) {
      return true;
    }
    throw error;
  } finally {
    await close(sql);
  }
}

export async function runDbMigrate(
  deps: DbMigrateDeps,
  progress: Progress = { stage: "env" },
): Promise<DbMigrateResult> {
  progress.stage = "env";
  const pem = deps.pem;
  const env = pem === undefined ? undefined : readOpsEnv(deps.source);
  if (pem === undefined || env === undefined) {
    return failed("env\n");
  }

  let master: Connection | undefined;
  try {
    // The connect stage runs up to and including the first successful query,
    // and through the role logins: a login that fails for any reason other than
    // a refusal is a connect failure, not a bootstrap failure.
    progress.stage = "connect";
    const { host, port, database, user } = env;
    master = deps.connect({ host, port, database, user, password: env.master, ca: pem });
    const migrator = await master`select 1 from pg_roles where rolname = 'migrator'`;
    if (migrator.length === 0) {
      return failed("not_bootstrapped\n");
    }
    for (const role of LOGIN_ROLES) {
      const refused = await loginRefused(() =>
        deps.connect({ host, port, database, user: role, password: env[role], ca: pem }),
      );
      if (refused) {
        return failed("not_bootstrapped\n");
      }
    }

    progress.stage = "migrate";
    const report = await applyProductMigrations(master);
    const applied = report.applied.map((tag) => `applied ${tag}\n`).join("");
    return {
      exitCode: 0,
      stdout: `${applied}done applied=${report.applied.length} total=${report.total}\n`,
      stderr: "",
    };
  } catch (error) {
    if (progress.stage === "connect" || progress.stage === "migrate") {
      return failed(failureLine(progress.stage, error));
    }
    return failed(`${progress.stage}\n`);
  } finally {
    await close(master);
  }
}

/**
 * The top-level backstop. Whatever `run` throws, the output is the stage word
 * the run had reached and nothing from the error.
 */
export async function runDbMigrateMain(deps: {
  source: NodeJS.ProcessEnv;
  pem: string | undefined;
  connect: typeof createDirectSql;
  run?: typeof runDbMigrate;
}): Promise<DbMigrateResult> {
  const progress: Progress = { stage: "env" };
  const run = deps.run ?? runDbMigrate;
  try {
    return await run({ source: deps.source, pem: deps.pem, connect: deps.connect }, progress);
  } catch {
    return failed(`${progress.stage}\n`);
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void runDbMigrateMain({
    source: process.env,
    pem: loadImageCa(),
    connect: createDirectSql,
  }).then((result) => {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  });
}
