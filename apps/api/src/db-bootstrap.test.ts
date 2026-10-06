import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlTarget } from "@community-hub/db";
import { describe, expect, it } from "vitest";

import { runDbBootstrap, type DbBootstrapDeps } from "./db-bootstrap.js";

const MARKER = "planted-password-marker";

const pem = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../certs/rds-ap-southeast-2-bundle.pem"),
  "utf8",
);

const ROLE_ROWS = ["migrator", "app", "identity", "platform"].map((rolname) => ({
  rolname,
  rolcanlogin: rolname !== "migrator",
  rolsuper: false,
  rolbypassrls: false,
  rolcreaterole: false,
  rolcreatedb: false,
}));

type ThrowOn = "bootstrap" | "alter_role" | "max_connections";

function joinQuery(strings: TemplateStringsArray, values: readonly unknown[]): string {
  return strings.reduce(
    (text, part, index) => text + part + (index < values.length ? String(values[index]) : ""),
    "",
  );
}

function fakeSql(
  throwOn?: ThrowOn,
  throwMessage = "driver",
): {
  sql: DbBootstrapDeps["connect"] extends (target: SqlTarget) => infer R ? R : never;
  statements: string[];
} {
  const statements: string[] = [];

  function reject(message: string): Promise<never> {
    return Promise.reject(new Error(message));
  }

  function answer(text: string): Promise<unknown> {
    statements.push(text);
    if (throwOn === "bootstrap" && !text.includes("ALTER ROLE")) {
      return reject(throwMessage);
    }
    if (throwOn === "alter_role" && text.includes("PASSWORD")) {
      return reject(throwMessage);
    }
    if (throwOn === "max_connections" && /max_connections/i.test(text)) {
      return reject(throwMessage);
    }
    if (/rolsuper/.test(text) && /current_user/.test(text)) {
      return Promise.resolve([{ rolsuper: false }]);
    }
    if (/rolcanlogin/.test(text)) {
      return Promise.resolve(ROLE_ROWS);
    }
    if (/max_connections/i.test(text)) {
      return Promise.resolve([{ max_connections: "100" }]);
    }
    return Promise.resolve([]);
  }

  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => answer(joinQuery(strings, values)),
    {
      unsafe(text: string) {
        const pending = answer(text);
        return Object.assign(pending, {
          simple: () => pending,
        });
      },
      end: () => Promise.resolve(),
    },
  );

  return {
    sql: sql as DbBootstrapDeps["connect"] extends (target: SqlTarget) => infer R ? R : never,
    statements,
  };
}

function source(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PGHOST: "db.example.test",
    PGPORT: "5432",
    PGDATABASE: "communityhub",
    PGUSER: "postgres",
    PGPASSWORD_MASTER: MARKER,
    PGPASSWORD_APP: MARKER,
    PGPASSWORD_IDENTITY: MARKER,
    PGPASSWORD_PLATFORM: MARKER,
    ...overrides,
  };
}

function harness(
  throwOn?: ThrowOn,
  throwMessage = "driver",
  env: NodeJS.ProcessEnv = source(),
): {
  deps: DbBootstrapDeps;
  statements: string[];
  targets: SqlTarget[];
} {
  const { sql, statements } = fakeSql(throwOn, throwMessage);
  const targets: SqlTarget[] = [];
  return {
    statements,
    targets,
    deps: {
      source: env,
      pem,
      connect: (target) => {
        targets.push(target);
        return sql;
      },
    },
  };
}

describe("runDbBootstrap", () => {
  it("prints max_connections and never puts the password in a statement", async () => {
    const { deps, statements, targets } = harness();
    const result = await runDbBootstrap(deps);
    expect(result).toEqual({ exitCode: 0, stdout: "100\n", stderr: "" });
    expect(statements.join("\n")).not.toContain(MARKER);
    for (const role of ["app", "identity", "platform"]) {
      expect(
        statements.some(
          (text) =>
            text.includes(`ALTER ROLE ${role} PASSWORD '`) && text.includes("SCRAM-SHA-256$"),
        ),
      ).toBe(true);
    }
    expect(targets).toEqual([
      {
        host: "db.example.test",
        port: 5432,
        database: "communityhub",
        user: "postgres",
        password: MARKER,
        ca: pem,
      },
    ]);
    expect(targets[0]).not.toHaveProperty("PGPASSWORD_APP");

    const again = await runDbBootstrap(deps);
    expect(again).toEqual({ exitCode: 0, stdout: "100\n", stderr: "" });
  });

  it("fails on missing environment before connecting", async () => {
    const env = source();
    delete env.PGPASSWORD_APP;
    const { deps, targets } = harness(undefined, "driver", env);
    const result = await runDbBootstrap(deps);
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "env\n" });
    expect(targets).toEqual([]);
  });

  it("maps a bootstrap failure and hides a thrown password", async () => {
    const { deps, statements } = harness("bootstrap", MARKER);
    const result = await runDbBootstrap(deps);
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "bootstrap\n" });
    expect(result.stdout).not.toContain(MARKER);
    expect(result.stderr).not.toContain(MARKER);
    expect(statements.join("\n")).not.toContain(MARKER);
  });

  it("maps an alter-role failure and hides a thrown password", async () => {
    const { deps, statements } = harness("alter_role", MARKER);
    const result = await runDbBootstrap(deps);
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "alter_role\n" });
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
    expect(statements.join("\n")).not.toContain(MARKER);
  });

  it("maps a max_connections failure and hides a thrown password", async () => {
    const { deps, statements } = harness("max_connections", MARKER);
    const result = await runDbBootstrap(deps);
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "max_connections\n" });
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
    expect(statements.join("\n")).not.toContain(MARKER);
  });
});
