import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createOutbox } from "./outbox-adapter.js";

function pooledSqlIsNotAssignableToAppend(sql: Sql): void {
  const outbox = createOutbox();
  // @ts-expect-error pooled Sql is not assignable to append
  void outbox.append(sql, {
    eventName: "kernel.outbox.recorded.v1",
    payload: {},
    idempotencyKey: "k",
  });
}

describe("createOutbox", () => {
  it("returns an append function that pooled Sql cannot satisfy", () => {
    expect(typeof createOutbox().append).toBe("function");
    expect(typeof pooledSqlIsNotAssignableToAppend).toBe("function");
  });
});
