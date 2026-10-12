import { describe, expect, it } from "vitest";

import { createLogger, type LogFields } from "./logger.js";

describe("createLogger", () => {
  it("drops personal-data fields from output and counts each drop", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });

    const fields = {
      method: "GET",
      path: "/health",
      status: 200,
      duration: 12,
      requestId: "req-1",
    } satisfies LogFields;

    Object.assign(fields, {
      name: "Ada Lovelace",
      email: "ada@example.com",
      surprise: "not allowed",
    });

    logger.info("request completed", fields);

    expect(lines).toHaveLength(1);
    const output = lines[0] ?? "";
    expect(output).not.toContain("Ada Lovelace");
    expect(output).not.toContain("ada@example.com");
    expect(output).not.toContain("surprise");
    expect(output).not.toContain("not allowed");
    expect(output).toContain("GET");
    expect(output).toContain("/health");
    expect(logger.getDroppedFieldCount()).toBe(3);
  });

  it("keeps a valid new field and drops a failing value", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    logger.info("request", {
      gatewayRequestId: "abc/+=_-",
      reason: "missing_hostname_header",
      hostname: "au.api.example.test",
      operation: "decrypt",
      key_kind: "identity",
      outcome: "rejected",
    });
    logger.info("request", {
      gatewayRequestId: "has space",
      reason: "nope" as "missing_hostname_header",
      hostname: "NOT-LOWER",
      operation: "sign" as "decrypt",
      key_kind: "root" as "org",
      outcome: "maybe" as "ok",
    });
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(first.gatewayRequestId).toBe("abc/+=_-");
    expect(first.reason).toBe("missing_hostname_header");
    expect(first.hostname).toBe("au.api.example.test");
    expect(first.operation).toBe("decrypt");
    expect(first.key_kind).toBe("identity");
    expect(first.outcome).toBe("rejected");
    const second = lines[1] ?? "";
    expect(second).not.toContain("has space");
    expect(second).not.toContain("NOT-LOWER");
    expect(second).not.toContain("nope");
    expect(logger.getDroppedFieldCount()).toBe(6);
  });

  it("passes a valid error class name and error code through", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    logger.info("request", { errorClass: "PostgresError", errorCode: "42P01" });
    logger.info("request", { errorClass: "Error_2", errorCode: "ECONNREFUSED" });
    logger.info("request", { errorClass: "E", errorCode: "28P01" });
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed[0]?.errorClass).toBe("PostgresError");
    expect(parsed[0]?.errorCode).toBe("42P01");
    expect(parsed[1]?.errorClass).toBe("Error_2");
    expect(parsed[1]?.errorCode).toBe("ECONNREFUSED");
    expect(parsed[2]?.errorClass).toBe("E");
    expect(parsed[2]?.errorCode).toBe("28P01");
    expect(logger.getDroppedFieldCount()).toBe(0);
  });

  it.each([
    ["spaces", "bad name"],
    ["an at sign", "ada@example.test"],
    ["a double quote", 'Bad"Name'],
    ["a single quote", "Bad'Name"],
    ["a newline", "Bad\nName"],
    ["a trailing newline", "Name\n"],
    ["a leading digit", "1Name"],
    ["a hyphen", "Bad-Name"],
    ["a dot", "pg.Error"],
    ["65 characters", "A".repeat(65)],
    ["empty", ""],
    ["a non-string", 42 as unknown as string],
  ])("replaces an error class name with %s by Error", (_label, name) => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    logger.info("request", { errorClass: name });
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.errorClass).toBe("Error");
    if (typeof name === "string" && name !== "") {
      expect(lines[0]).not.toContain(name);
    }
  });

  it("accepts an error class name of exactly 64 characters", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    const name = `A${"b".repeat(63)}`;
    logger.info("request", { errorClass: name });
    expect((JSON.parse(lines[0] ?? "{}") as Record<string, unknown>).errorClass).toBe(name);
  });

  it.each([
    ["spaces", "42 P01"],
    ["an at sign", "A@B"],
    ["a double quote", 'A"B'],
    ["a single quote", "A'B"],
    ["a newline", "A\nB"],
    ["a trailing newline", "42P01\n"],
    ["lower case", "econnrefused"],
    ["a hyphen", "A-B"],
    ["33 characters", "A".repeat(33)],
    ["empty", ""],
    ["a number", 42 as unknown as string],
    ["an object", {} as unknown as string],
  ])("omits an error code with %s", (_label, code) => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    logger.info("request", { errorCode: code });
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect("errorCode" in parsed).toBe(false);
    if (typeof code === "string" && code !== "") {
      expect(lines[0]).not.toContain(code);
    }
    expect(logger.getDroppedFieldCount()).toBe(1);
  });

  it("accepts an error code of exactly 32 characters", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    const code = "A".repeat(32);
    logger.info("request", { errorCode: code });
    expect((JSON.parse(lines[0] ?? "{}") as Record<string, unknown>).errorCode).toBe(code);
  });

  it("never throws on bad field input", () => {
    const logger = createLogger({ write: () => {} });

    expect(() => logger.info("ok", null as unknown as LogFields)).not.toThrow();
    expect(() => logger.info("ok", undefined)).not.toThrow();
    expect(() => logger.info("ok", 42 as unknown as LogFields)).not.toThrow();
    expect(() => logger.info("ok", "nope" as unknown as LogFields)).not.toThrow();
  });
});
