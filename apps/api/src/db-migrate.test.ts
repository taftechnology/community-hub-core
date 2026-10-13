import { applyProductMigrations, type MigrationReport, type SqlTarget } from "@community-hub/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  runDbMigrate,
  runDbMigrateMain,
  type DbMigrateDeps,
  type DbMigrateResult,
  type Progress,
} from "./db-migrate.js";

vi.mock("@community-hub/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@community-hub/db")>();
  return { ...actual, applyProductMigrations: vi.fn() };
});

const MARKER = "planted-password-marker";
const PEM = "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n";
const HOST = "planted-host.example.test";
const DATABASE = "planted-database-marker";
const USER = "planted-user-marker";
const PASSWORDS = {
  master: `${MARKER}-master`,
  app: `${MARKER}-app`,
  identity: `${MARKER}-identity`,
  platform: `${MARKER}-platform`,
};
const CONNECTION_STRING = `postgres://${USER}:${PASSWORDS.master}@${HOST}:5432/${DATABASE}`;
const SQL_TEXT = "select planted_sql_marker from planted_table_marker";
const PLANTED = [
  ...Object.values(PASSWORDS),
  HOST,
  DATABASE,
  USER,
  CONNECTION_STRING,
  "planted_sql_marker",
  "planted_table_marker",
  MARKER,
];

const NAMES = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD_MASTER",
  "PGPASSWORD_APP",
  "PGPASSWORD_IDENTITY",
  "PGPASSWORD_PLATFORM",
] as const;

const ALLOWED = [
  /^(applied [0-9]{4}_[a-z0-9_]+\n)*done applied=[0-9]+ total=[0-9]+\n$/,
  /^(env|not_bootstrapped)\n$/,
  /^(connect|migrate)( [0-9A-Z]{5})?\n$/,
];

function source(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PGHOST: HOST,
    PGPORT: "5432",
    PGDATABASE: DATABASE,
    PGUSER: USER,
    PGPASSWORD_MASTER: PASSWORDS.master,
    PGPASSWORD_APP: PASSWORDS.app,
    PGPASSWORD_IDENTITY: PASSWORDS.identity,
    PGPASSWORD_PLATFORM: PASSWORDS.platform,
    ...overrides,
  };
}

/** The shape postgres.js throws for a server error. */
function pgError(code: string): Error {
  const error = new Error(`server text ${SQL_TEXT} ${CONNECTION_STRING}`);
  error.name = "PostgresError";
  return Object.assign(error, { severity: "ERROR", code, query: SQL_TEXT });
}

/** The shape drizzle-orm 0.45.2 throws from migrate: SQL in the message, no code, the driver error as cause. */
function drizzleWrapper(cause: unknown): Error {
  const wrapper = new Error(
    `Failed query: ${SQL_TEXT} params: ${PASSWORDS.app}, ${CONNECTION_STRING}`,
    { cause },
  );
  return Object.assign(wrapper, { query: SQL_TEXT, params: [PASSWORDS.app, HOST] });
}

function errno(code: string): Error {
  return Object.assign(new Error(`socket ${HOST} ${MARKER}`), { code });
}

function tlsError(): Error {
  return Object.assign(new Error(`certificate does not match ${HOST} ${MARKER}`), {
    marker: MARKER,
  });
}

type Scenario = {
  env?: NodeJS.ProcessEnv;
  noPem?: boolean;
  /** Thrown by the factory itself, per login user. */
  factoryThrows?: Record<string, unknown>;
  /** Rejection of the first query on that user's connection. */
  queryRejects?: Record<string, unknown>;
  noMigratorRow?: boolean;
  endRejects?: boolean;
  runner?: MigrationReport | { reject: unknown };
};

type Sql = ReturnType<DbMigrateDeps["connect"]>;

type Outcome = {
  deps: DbMigrateDeps;
  targets: SqlTarget[];
  connections: Sql[];
  /** How many times end() was called on each connection, in creation order. */
  ends: number[];
  statements: string[];
  run(): Promise<DbMigrateResult>;
};

function joinQuery(strings: TemplateStringsArray, values: readonly unknown[]): string {
  return strings.reduce(
    (text, part, index) => text + part + (index < values.length ? String(values[index]) : ""),
    "",
  );
}

function harness(scenario: Scenario = {}): Outcome {
  const targets: SqlTarget[] = [];
  const connections: Sql[] = [];
  const ends: number[] = [];
  const statements: string[] = [];
  const env = scenario.env ?? source();

  function fakeSql(user: string): Sql {
    const index = ends.length;
    ends.push(0);
    const rejection = scenario.queryRejects?.[user];
    const sql = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = joinQuery(strings, values);
        statements.push(text);
        if (rejection !== undefined) {
          return Promise.reject(rejection);
        }
        if (/pg_roles/.test(text)) {
          return Promise.resolve(scenario.noMigratorRow === true ? [] : [{ one: 1 }]);
        }
        return Promise.resolve([{ one: 1 }]);
      },
      {
        end: () => {
          ends[index] = (ends[index] ?? 0) + 1;
          return scenario.endRejects === true
            ? Promise.reject(new Error(`${MARKER} end ${SQL_TEXT}`))
            : Promise.resolve();
        },
      },
    );
    return sql as unknown as Sql;
  }

  const deps: DbMigrateDeps = {
    source: env,
    pem: scenario.noPem === true ? undefined : PEM,
    connect: (target) => {
      targets.push(target);
      if (scenario.factoryThrows !== undefined && target.user in scenario.factoryThrows) {
        throw scenario.factoryThrows[target.user];
      }
      const sql = fakeSql(target.user);
      connections.push(sql);
      return sql;
    },
  };

  const mocked = vi.mocked(applyProductMigrations);
  mocked.mockReset();
  const runner = scenario.runner ?? { applied: [], total: 8 };
  if ("reject" in runner) {
    mocked.mockRejectedValue(runner.reject);
  } else {
    mocked.mockResolvedValue(runner);
  }

  return {
    deps,
    targets,
    connections,
    ends,
    statements,
    async run() {
      const result = await runDbMigrate(deps);
      // The log-content test, applied to every case in this file.
      const output = `${result.stdout}${result.stderr}`;
      expect(ALLOWED.some((form) => form.test(output))).toBe(true);
      for (const value of PLANTED) {
        expect(output).not.toContain(value);
        expect(statements.join("\n")).not.toContain(value);
      }
      expect(result.exitCode).toBe(result.stderr === "" ? 0 : 1);
      if (result.exitCode === 1) {
        expect(result.stdout).toBe("");
      }
      // Every connection the factory returned is ended exactly once, on every path.
      expect(ends).toEqual(connections.map(() => 1));
      return result;
    },
  };
}

const failure = (stderr: string): DbMigrateResult => ({ exitCode: 1, stdout: "", stderr });

beforeEach(() => {
  vi.mocked(applyProductMigrations).mockReset();
});

describe("runDbMigrate environment", () => {
  const cases: [string, NodeJS.ProcessEnv][] = [
    ...NAMES.flatMap((name): [string, NodeJS.ProcessEnv][] => [
      [`${name} missing`, { [name]: undefined }],
      [`${name} empty`, { [name]: "" }],
    ]),
    ...["0", "65536", "abc", "8e3", " 5432"].map((port): [string, NodeJS.ProcessEnv] => [
      `bad port ${JSON.stringify(port)}`,
      { PGPORT: port },
    ]),
  ];

  it.each(cases)("%s: env, and no connection", async (_label, overrides) => {
    const { targets, run } = harness({ env: source(overrides) });
    const result = await run();
    expect(result).toEqual(failure("env\n"));
    expect(targets).toEqual([]);
    expect(vi.mocked(applyProductMigrations)).not.toHaveBeenCalled();
  });

  it("an unreadable CA bundle is env, and no connection", async () => {
    const { targets, run } = harness({ noPem: true });
    expect(await run()).toEqual(failure("env\n"));
    expect(targets).toEqual([]);
  });
});

describe("runDbMigrate connect stage", () => {
  it("a factory that throws is connect", async () => {
    const { run } = harness({ factoryThrows: { [USER]: tlsError() } });
    expect(await run()).toEqual(failure("connect\n"));
  });

  it("a rejected first query with a PostgresError keeps its SQLSTATE", async () => {
    const { ends, run } = harness({ queryRejects: { [USER]: pgError("28P01") } });
    expect(await run()).toEqual(failure("connect 28P01\n"));
    expect(ends).toEqual([1]);
  });

  it("a TLS-style error and an errno code are the bare word", async () => {
    expect(await harness({ queryRejects: { [USER]: tlsError() } }).run()).toEqual(
      failure("connect\n"),
    );
    expect(await harness({ queryRejects: { [USER]: errno("EPIPE") } }).run()).toEqual(
      failure("connect\n"),
    );
  });
});

describe("runDbMigrate bootstrap check", () => {
  it("no migrator row: not_bootstrapped, and the runner is never called", async () => {
    const { targets, ends, run } = harness({ noMigratorRow: true });
    expect(await run()).toEqual(failure("not_bootstrapped\n"));
    expect(ends).toEqual([1]);
    expect(vi.mocked(applyProductMigrations)).not.toHaveBeenCalled();
    expect(targets.map((target) => target.user)).toEqual([USER]);
  });

  it.each([
    ["app", "28P01"],
    ["identity", "28P01"],
    ["platform", "28P01"],
    ["app", "28000"],
    ["identity", "28000"],
    ["platform", "28000"],
  ])("a refused login for %s (%s): not_bootstrapped", async (role, code) => {
    const { ends, run } = harness({ queryRejects: { [role]: pgError(code) } });
    expect(await run()).toEqual(failure("not_bootstrapped\n"));
    expect(ends).toEqual(
      Array.from({ length: 2 + ["app", "identity", "platform"].indexOf(role) }, () => 1),
    );
    expect(vi.mocked(applyProductMigrations)).not.toHaveBeenCalled();
  });

  it("another PostgresError code on a role login is connect with that code", async () => {
    const { run } = harness({ queryRejects: { identity: pgError("53300") } });
    expect(await run()).toEqual(failure("connect 53300\n"));
  });

  it("a role login that fails with no code is connect", async () => {
    const { run } = harness({ queryRejects: { app: tlsError() } });
    expect(await run()).toEqual(failure("connect\n"));
  });

  it("a role-login connect that throws a non-Postgres error is staged and reduced", async () => {
    const thrown = Object.assign(new Error(`${MARKER} ${HOST}`), { detail: MARKER });
    const { run } = harness({ factoryThrows: { platform: thrown } });
    const result = await run();
    expect(result).toEqual(failure("connect\n"));
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it("an errno code on a role login is the bare word", async () => {
    const { run } = harness({ queryRejects: { app: errno("EPIPE") } });
    expect(await run()).toEqual(failure("connect\n"));
  });
});

describe("runDbMigrate runner", () => {
  it("prints the SQLSTATE of the cause of a drizzle wrapper and nothing else", async () => {
    const { ends, run } = harness({ runner: { reject: drizzleWrapper(pgError("42501")) } });
    expect(await run()).toEqual(failure("migrate 42501\n"));
    expect(ends).toEqual([1, 1, 1, 1]);
  });

  it("an errno code in the cause is the bare word", async () => {
    const { run } = harness({ runner: { reject: drizzleWrapper(errno("EPIPE")) } });
    expect(await run()).toEqual(failure("migrate\n"));
  });

  it("a code two levels down is the bare word", async () => {
    const deep = drizzleWrapper(new Error("middle", { cause: pgError("42501") }));
    const { run } = harness({ runner: { reject: deep } });
    expect(await run()).toEqual(failure("migrate\n"));
  });

  it("a flat PostgresError keeps its SQLSTATE", async () => {
    const { run } = harness({ runner: { reject: pgError("42501") } });
    expect(await run()).toEqual(failure("migrate 42501\n"));
  });

  it("a plain Error is the bare word", async () => {
    const { run } = harness({ runner: { reject: new Error(`${MARKER} ${SQL_TEXT}`) } });
    expect(await run()).toEqual(failure("migrate\n"));
  });
});

describe("runDbMigrate success", () => {
  it("prints each applied tag and the counts", async () => {
    const { ends, run } = harness({
      runner: { applied: ["0006_people_org_scoped_uniques", "0007_fast_gorilla_man"], total: 8 },
    });
    const result = await run();
    expect(ends).toEqual([1, 1, 1, 1]);
    expect(result).toEqual({
      exitCode: 0,
      stdout:
        "applied 0006_people_org_scoped_uniques\napplied 0007_fast_gorilla_man\ndone applied=2 total=8\n",
      stderr: "",
    });
  });

  it("prints only the counts when nothing was applied", async () => {
    const { run } = harness({ runner: { applied: [], total: 8 } });
    expect(await run()).toEqual({ exitCode: 0, stdout: "done applied=0 total=8\n", stderr: "" });
  });

  it("hands the runner the master connection", async () => {
    const { connections, run } = harness();
    await run();
    const mocked = vi.mocked(applyProductMigrations);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0]?.[0]).toBe(connections[0]);
  });
});

describe("runDbMigrate closing connections", () => {
  it("an end() that rejects changes no result", async () => {
    const ok = await harness({
      endRejects: true,
      runner: { applied: ["0007_fast_gorilla_man"], total: 8 },
    }).run();
    expect(ok).toEqual({
      exitCode: 0,
      stdout: "applied 0007_fast_gorilla_man\ndone applied=1 total=8\n",
      stderr: "",
    });
    expect(await harness({ endRejects: true, noMigratorRow: true }).run()).toEqual(
      failure("not_bootstrapped\n"),
    );
    expect(
      await harness({
        endRejects: true,
        runner: { reject: drizzleWrapper(pgError("42501")) },
      }).run(),
    ).toEqual(failure("migrate 42501\n"));
    expect(
      await harness({ endRejects: true, queryRejects: { [USER]: pgError("28P01") } }).run(),
    ).toEqual(failure("connect 28P01\n"));
  });
});

describe("runDbMigrate connection targets", () => {
  it("gives the master password only to the master and each role password only to its role", async () => {
    const { targets, run } = harness();
    await run();
    expect(targets).toEqual([
      {
        host: HOST,
        port: 5432,
        database: DATABASE,
        user: USER,
        password: PASSWORDS.master,
        ca: PEM,
      },
      { host: HOST, port: 5432, database: DATABASE, user: "app", password: PASSWORDS.app, ca: PEM },
      {
        host: HOST,
        port: 5432,
        database: DATABASE,
        user: "identity",
        password: PASSWORDS.identity,
        ca: PEM,
      },
      {
        host: HOST,
        port: 5432,
        database: DATABASE,
        user: "platform",
        password: PASSWORDS.platform,
        ca: PEM,
      },
    ]);
    for (const target of targets) {
      expect(target).not.toHaveProperty("servername");
    }
    const [master, ...roles] = targets;
    for (const role of roles) {
      expect(role.password).not.toBe(master?.password);
    }
    expect(master?.password).toBe(PASSWORDS.master);
  });
});

describe("runDbMigrateMain", () => {
  const base = (): Pick<DbMigrateDeps, "source" | "pem" | "connect"> => ({
    source: source(),
    pem: PEM,
    connect: () => {
      throw new Error("not used");
    },
  });

  it("prints the stage word the run had reached and nothing from the error", async () => {
    const thrown = Object.assign(new Error(`${MARKER} ${SQL_TEXT}`), { detail: MARKER });
    const run = vi.fn(async (_deps: DbMigrateDeps, progress?: Progress) => {
      if (progress !== undefined) {
        progress.stage = "migrate";
      }
      throw thrown;
    });
    const result = await runDbMigrateMain({ ...base(), run });
    expect(result).toEqual(failure("migrate\n"));
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it("prints env when the run rejects before it sets a stage", async () => {
    const run = vi.fn(async () => {
      throw new Error(MARKER);
    });
    expect(await runDbMigrateMain({ ...base(), run })).toEqual(failure("env\n"));
  });

  it("returns the result of a run that resolves, as it is", async () => {
    const resolved: DbMigrateResult = {
      exitCode: 0,
      stdout: "done applied=0 total=8\n",
      stderr: "",
    };
    const run = vi.fn(async () => resolved);
    expect(await runDbMigrateMain({ ...base(), run })).toBe(resolved);
  });

  it("ends every connection when the default run succeeds", async () => {
    const { deps, ends } = harness({ runner: { applied: [], total: 8 } });
    const result = await runDbMigrateMain({ ...deps });
    expect(result).toEqual({ exitCode: 0, stdout: "done applied=0 total=8\n", stderr: "" });
    expect(ends).toEqual([1, 1, 1, 1]);
  });

  it("ends every connection even when the caller of the run rejects afterwards", async () => {
    const { deps, ends } = harness({ runner: { applied: [], total: 8 } });
    const run = async (inner: DbMigrateDeps, progress?: Progress) => {
      await runDbMigrate(inner, progress);
      throw new Error(MARKER);
    };
    const result = await runDbMigrateMain({ ...deps, run });
    expect(result).toEqual(failure("migrate\n"));
    expect(ends).toEqual([1, 1, 1, 1]);
  });

  it("with the default run and no CA bundle, prints env", async () => {
    expect(await runDbMigrateMain({ ...base(), pem: undefined })).toEqual(failure("env\n"));
  });
});
