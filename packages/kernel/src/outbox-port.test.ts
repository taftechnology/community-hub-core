import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineModule } from "./define-module";
import { defineEvent } from "./event";
import { bindPublisher, type OutboxPort } from "./outbox-port";
import { withRequest } from "./request";

const payload = z.object({ personId: z.string() });

function personMergedEvent() {
  return defineEvent({
    name: "people.person.merged.v1",
    payload,
  });
}

function peopleModule(publishes: string[]) {
  return defineModule({
    key: "people",
    version: 1,
    requires: [],
    publishes,
    subscribes: [],
    ports: [],
  });
}

function memoryOutbox(): OutboxPort<unknown> & {
  rows: Array<{ eventName: string; payload: unknown; idempotencyKey: string }>;
} {
  const rows: Array<{ eventName: string; payload: unknown; idempotencyKey: string }> = [];
  return {
    rows,
    async append(_tx, row) {
      rows.push(row);
      return { id: "row-1" };
    },
  };
}

describe("bindPublisher", () => {
  it("throws when publish is called outside withRequest", async () => {
    const event = personMergedEvent();
    const { publish } = bindPublisher(peopleModule([event.name]), memoryOutbox());

    await expect(publish({}, event, { personId: "p-1" })).rejects.toThrow();
  });

  it("throws when the event is not in module publishes", async () => {
    const event = personMergedEvent();
    const { publish } = bindPublisher(peopleModule([]), memoryOutbox());

    await withRequest({ requestId: "req-1", idempotencyKey: "idem-1" }, async () => {
      await expect(publish({}, event, { personId: "p-1" })).rejects.toThrow();
    });
  });

  it("throws when Zod parse fails", async () => {
    const event = personMergedEvent();
    const { publish } = bindPublisher(peopleModule([event.name]), memoryOutbox());

    await withRequest({ requestId: "req-1", idempotencyKey: "idem-1" }, async () => {
      await expect(publish({}, event, { personId: 99 })).rejects.toThrow();
    });
  });

  it("appends the parsed payload and ALS idempotency key, not a fresh id", async () => {
    const event = personMergedEvent();
    const outbox = memoryOutbox();
    const { publish } = bindPublisher(peopleModule([event.name]), outbox);
    const idempotencyKey = "client-idempotency-key";

    const result = await withRequest({ requestId: "req-1", idempotencyKey }, async () => {
      return publish({}, event, { personId: "p-1" });
    });

    expect(result).toEqual({ id: "row-1" });
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]).toEqual({
      eventName: "people.person.merged.v1",
      payload: { personId: "p-1" },
      idempotencyKey,
    });
  });
});
