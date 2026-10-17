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

  it("keeps send_email operation and drops unknown operations", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    logger.info("mail", {
      operation: "send_email" as unknown as "decrypt",
      outcome: "ok",
    });
    logger.info("mail", {
      operation: "unknown_op" as unknown as "decrypt",
      outcome: "ok",
    });
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(first.operation).toBe("send_email");
    const second = lines[1] ?? "";
    expect(second).not.toContain("unknown_op");
    expect(logger.getDroppedFieldCount()).toBe(1);
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
    ["41 characters", "A".repeat(41)],
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

  it("accepts an error code of exactly 40 characters", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    const code = "A".repeat(40);
    logger.info("request", { errorCode: code });
    expect((JSON.parse(lines[0] ?? "{}") as Record<string, unknown>).errorCode).toBe(code);
  });

  it("accepts the 33-character TLS code for an unknown issuer", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    logger.info("request", { errorCode: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" });
    expect((JSON.parse(lines[0] ?? "{}") as Record<string, unknown>).errorCode).toBe(
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    );
    expect(logger.getDroppedFieldCount()).toBe(0);
  });

  it("never throws on bad field input", () => {
    const logger = createLogger({ write: () => {} });

    expect(() => logger.info("ok", null as unknown as LogFields)).not.toThrow();
    expect(() => logger.info("ok", undefined)).not.toThrow();
    expect(() => logger.info("ok", 42 as unknown as LogFields)).not.toThrow();
    expect(() => logger.info("ok", "nope" as unknown as LogFields)).not.toThrow();
  });

  it("keeps valid billing operations, outcomes, and fields", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    logger.info("stripe call", {
      operation: "stripe_call" as unknown as "decrypt",
      outcome: "processed" as unknown as "ok",
      organisationId: "12345678-1234-4234-8234-1234567890ab",
      stripeEventId: "evt_1234567890abcdef",
      stripeEventType: "customer.subscription.updated",
    } as unknown as LogFields);
    logger.info("webhook", {
      operation: "stripe_webhook" as unknown as "decrypt",
      outcome: "ignored" as unknown as "ok",
      stripeEventId: "evt_9999",
      stripeEventType: "invoice.paid",
    } as unknown as LogFields);
    logger.info("admin", {
      operation: "billing_admin" as unknown as "decrypt",
      outcome: "ok",
    } as unknown as LogFields);

    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(first.operation).toBe("stripe_call");
    expect(first.outcome).toBe("processed");
    expect(first.organisationId).toBe("12345678-1234-4234-8234-1234567890ab");
    expect(first.stripeEventId).toBe("evt_1234567890abcdef");
    expect(first.stripeEventType).toBe("customer.subscription.updated");

    const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    expect(second.operation).toBe("stripe_webhook");
    expect(second.outcome).toBe("ignored");
    expect(second.stripeEventId).toBe("evt_9999");
    expect(second.stripeEventType).toBe("invoice.paid");

    const third = JSON.parse(lines[2] ?? "{}") as Record<string, unknown>;
    expect(third.operation).toBe("billing_admin");
    expect(third.outcome).toBe("ok");

    expect(logger.getDroppedFieldCount()).toBe(0);
  });

  it("drops and counts invalid billing field values", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });

    // An email in stripeEventType
    logger.info("bad event type", {
      stripeEventType: "ada@example.test",
    } as unknown as LogFields);

    // A non-UUID organisationId
    logger.info("bad org id", {
      organisationId: "not-a-uuid",
    } as unknown as LogFields);

    // An evt id with a space
    logger.info("bad event id", {
      stripeEventId: "evt_has space",
    } as unknown as LogFields);

    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect("stripeEventType" in first).toBe(false);
    expect(lines[0]).not.toContain("ada@example.test");

    const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    expect("organisationId" in second).toBe(false);
    expect(lines[1]).not.toContain("not-a-uuid");

    const third = JSON.parse(lines[2] ?? "{}") as Record<string, unknown>;
    expect("stripeEventId" in third).toBe(false);
    expect(lines[2]).not.toContain("evt_has space");

    expect(logger.getDroppedFieldCount()).toBe(3);
  });
});
