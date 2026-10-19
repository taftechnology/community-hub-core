import { describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";

describe("logger compile-time field typing", () => {
  it("documents @ts-expect-error below for pnpm typecheck", () => {
    const logger = createLogger({ write: () => {} });
    const untyped: Record<string, unknown> = {
      method: "GET",
      path: "/health",
    };

    logger.info("kms", {
      gatewayRequestId: "abc/+=_-",
      reason: "missing_hostname_header",
      hostname: "au.api.example.test",
      operation: "decrypt",
      key_kind: "identity",
      outcome: "rejected",
      errorClass: "PostgresError",
      errorCode: "42P01",
    });

    logger.info("mail", {
      operation: "send_email",
      outcome: "ok",
    });

    logger.info("billing", {
      operation: "stripe_call",
      outcome: "processed",
      organisationId: "12345678-1234-4234-8234-1234567890ab",
      stripeEventId: "evt_1234",
      stripeEventType: "customer.subscription.updated",
    });

    logger.info("billing webhook", {
      operation: "stripe_webhook",
      outcome: "ignored",
    });

    logger.info("billing admin", {
      operation: "billing_admin",
      outcome: "ok",
    });

    // @ts-expect-error untyped records must not be accepted by the logger API
    logger.info("request", untyped);

    expect(logger.getDroppedFieldCount()).toBe(0);
  });
});
