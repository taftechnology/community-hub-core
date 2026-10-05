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

  it("never throws on bad field input", () => {
    const logger = createLogger({ write: () => {} });

    expect(() => logger.info("ok", null as unknown as LogFields)).not.toThrow();
    expect(() => logger.info("ok", undefined)).not.toThrow();
    expect(() => logger.info("ok", 42 as unknown as LogFields)).not.toThrow();
    expect(() => logger.info("ok", "nope" as unknown as LogFields)).not.toThrow();
  });
});
