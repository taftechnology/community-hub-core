import type { ModuleDefinition } from "./define-module.js";
import type { DefinedEvent } from "./event.js";
import { getRequestContext } from "./request.js";

export type OutboxPort<Tx> = {
  append(
    tx: Tx,
    row: { eventName: string; payload: unknown; idempotencyKey: string },
  ): Promise<{ id: string }>;
};

export function bindPublisher<Tx>(
  module: ModuleDefinition,
  outbox: OutboxPort<Tx>,
): {
  publish(tx: Tx, event: DefinedEvent, payload: unknown): Promise<{ id: string }>;
} {
  return {
    async publish(tx, event, payload) {
      const ctx = getRequestContext();
      if (ctx.idempotencyKey === undefined) {
        throw new Error("idempotencyKey is missing");
      }
      if (!module.publishes.includes(event.name)) {
        throw new Error(`Event ${event.name} is not declared in module publishes`);
      }
      const parsed: unknown = event.payload.parse(payload);
      return outbox.append(tx, {
        eventName: event.name,
        payload: parsed,
        idempotencyKey: ctx.idempotencyKey,
      });
    },
  };
}
