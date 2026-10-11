import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { appendAuditEvent } from "./audit-append.js";
import type { AppTransaction } from "./tx.js";

const auditInput = {
  actorKind: "system",
  actorId: null,
  action: "audit.append.recorded",
  purpose: "audit.append.test",
  targetIds: [],
} as const;

function acceptsAppTransaction(tx: AppTransaction): void {
  void appendAuditEvent(tx, auditInput);
}

function rejectsPooledSql(sql: Sql): void {
  // @ts-expect-error pooled Sql is not assignable to append
  void appendAuditEvent(sql, auditInput);
}

describe("appendAuditEvent transaction parameter", () => {
  it("accepts an app transaction and rejects a pooled connection", () => {
    expect(typeof acceptsAppTransaction).toBe("function");
    expect(typeof rejectsPooledSql).toBe("function");
    expect(typeof appendAuditEvent).toBe("function");
  });
});
