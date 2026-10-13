import { describe, expect, it } from "vitest";

import { failureLine, sqlstate } from "./db-ops-error.js";

const MARKER = "planted-password-marker";

function postgresError(code: string, shape: "both" | "name" | "severity" = "both"): Error {
  const error = new Error(`driver text ${MARKER}`);
  if (shape !== "severity") {
    error.name = "PostgresError";
  }
  if (shape !== "name") {
    Object.assign(error, { severity: "ERROR" });
  }
  Object.assign(error, { code });
  return error;
}

function errno(code: string): Error {
  return Object.assign(new Error(`socket ${MARKER}`), { code });
}

/** The shape drizzle-orm 0.45.2 throws: SQL in the message, no code, the driver error as cause. */
function drizzleWrapper(cause: unknown): Error {
  const wrapper = new Error(
    `Failed query: select ${MARKER} from db.example.test params: ${MARKER}, postgres://u:${MARKER}@db.example.test/x`,
    { cause },
  );
  Object.assign(wrapper, { query: `select ${MARKER}`, params: [MARKER] });
  return wrapper;
}

describe("failureLine", () => {
  it("prints the code of a flat PostgresError", () => {
    expect(failureLine("migrate", postgresError("42501"))).toBe("migrate 42501\n");
    expect(failureLine("connect", postgresError("28P01"))).toBe("connect 28P01\n");
  });

  it("accepts severity alone and name alone", () => {
    expect(failureLine("migrate", postgresError("42501", "severity"))).toBe("migrate 42501\n");
    expect(failureLine("migrate", postgresError("42501", "name"))).toBe("migrate 42501\n");
  });

  it("reads the code from the cause of a drizzle wrapper", () => {
    expect(failureLine("migrate", drizzleWrapper(postgresError("42501")))).toBe("migrate 42501\n");
  });

  it("prints the bare word for a node errno code, at any level", () => {
    expect(failureLine("migrate", drizzleWrapper(errno("EPIPE")))).toBe("migrate\n");
    for (const code of ["EPIPE", "EPERM", "EBADF"]) {
      expect(failureLine("connect", errno(code))).toBe("connect\n");
    }
  });

  it("does not look two levels down", () => {
    const deep = drizzleWrapper(new Error("middle", { cause: postgresError("42501") }));
    expect(failureLine("migrate", deep)).toBe("migrate\n");
  });

  it("does not fall through to the cause when the top-level code fails the check", () => {
    const top = Object.assign(new Error("socket", { cause: postgresError("42501") }), {
      code: "EPIPE",
    });
    expect(failureLine("migrate", top)).toBe("migrate\n");
  });

  it("rejects malformed codes", () => {
    expect(failureLine("migrate", postgresError("42p01"))).toBe("migrate\n");
    expect(failureLine("migrate", postgresError("420011"))).toBe("migrate\n");
    expect(failureLine("migrate", Object.assign(postgresError("42501"), { code: 42501 }))).toBe(
      "migrate\n",
    );
  });

  it("prints the bare word for things that carry no code", () => {
    for (const value of [new Error(MARKER), MARKER, null, undefined, 42, {}]) {
      expect(failureLine("migrate", value)).toBe("migrate\n");
    }
  });

  it("never reads message, query, params, stack or cause.message", () => {
    const touched: string[] = [];
    function trap(target: object, key: string): void {
      Object.defineProperty(target, key, {
        get() {
          touched.push(key);
          throw new Error(MARKER);
        },
      });
    }
    const cause = postgresError("42501");
    trap(cause, "message");
    trap(cause, "stack");
    const wrapper = new Error("x", { cause });
    for (const key of ["message", "query", "params", "stack"]) {
      trap(wrapper, key);
    }
    expect(failureLine("migrate", wrapper)).toBe("migrate 42501\n");
    expect(touched).toEqual([]);
  });
});

describe("sqlstate", () => {
  it("returns the code or undefined", () => {
    expect(sqlstate(postgresError("23505"))).toBe("23505");
    expect(sqlstate(errno("EPIPE"))).toBeUndefined();
    expect(sqlstate(undefined)).toBeUndefined();
  });
});
