import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";
import { type PersonStatus } from "../domain/person.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SetPersonStatusInput = {
  now?: Date;
  personId: string;
  version: number;
  status: PersonStatus;
  actorUserId: string | null;
};

export type SetPersonStatusResult = {
  version: number;
  status: PersonStatus;
};

function actor(actorUserId: string | null): {
  actorKind: "system" | "user";
  actorId: string | null;
} {
  if (actorUserId === null) {
    return { actorKind: "system", actorId: null };
  }
  return { actorKind: "user", actorId: actorUserId };
}

export async function setPersonStatus(
  tx: AppTransaction,
  input: SetPersonStatusInput,
): Promise<SetPersonStatusResult> {
  if (typeof input.personId !== "string" || !UUID_RE.test(input.personId)) {
    throw new PeopleError("invalid_input");
  }
  if (typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 1) {
    throw new PeopleError("invalid_input");
  }
  if (input.status !== "active" && input.status !== "inactive") {
    throw new PeopleError("invalid_input");
  }
  if (
    input.actorUserId !== null &&
    (typeof input.actorUserId !== "string" || !UUID_RE.test(input.actorUserId))
  ) {
    throw new PeopleError("invalid_input");
  }

  const updatedRows = await tx<{ version: number; status: string }[]>`
    update app.persons
    set
      status = ${input.status},
      version = version + 1
    where id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = false
      and version = ${input.version}
      and status <> ${input.status}
    returning version, status
  `;

  if (updatedRows[0] !== undefined) {
    const rec = actor(input.actorUserId);
    await appendAuditEvent(tx, {
      actorKind: rec.actorKind,
      actorId: rec.actorId,
      action: "people.person.status_changed",
      purpose: "people.person.status_changed",
      targetIds: [input.personId],
    });

    return {
      version: updatedRows[0].version,
      status: updatedRows[0].status as PersonStatus,
    };
  }

  const fallbackRows = await tx<{ version: number; status: string }[]>`
    select
      version,
      status
    from app.persons
    where id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = false
  `;

  const existing = fallbackRows[0];
  if (existing === undefined) {
    throw new PeopleError("not_found");
  }

  if (existing.version !== input.version) {
    throw new PeopleError("conflict");
  }

  return {
    version: existing.version,
    status: existing.status as PersonStatus,
  };
}
