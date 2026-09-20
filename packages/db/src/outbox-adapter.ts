import type { OutboxPort } from "@community-hub/kernel/module";

import { newId } from "./ids.js";
import type { AppTransaction, OrgTransaction } from "./tx.js";

export function createOutbox(): OutboxPort<AppTransaction | OrgTransaction> {
  return {
    async append(tx, row) {
      const id = newId();
      const payload = JSON.stringify(row.payload);
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO app.outbox (id, org_id, event_name, payload, idempotency_key)
        VALUES (
          ${id},
          current_setting('app.org_id')::uuid,
          ${row.eventName},
          ${payload}::jsonb,
          ${row.idempotencyKey}
        )
        ON CONFLICT ON CONSTRAINT outbox_org_id_event_name_idempotency_key_unique DO NOTHING
        RETURNING id
      `;
      const insertedId = inserted[0]?.id;
      if (insertedId !== undefined) {
        return { id: insertedId };
      }
      const existing = await tx<{ id: string }[]>`
        SELECT id FROM app.outbox
        WHERE org_id = current_setting('app.org_id')::uuid
          AND event_name = ${row.eventName}
          AND idempotency_key = ${row.idempotencyKey}
      `;
      const existingId = existing[0]?.id;
      if (existingId === undefined) {
        throw new Error("outbox row missing after conflict");
      }
      return { id: existingId };
    },
  };
}
