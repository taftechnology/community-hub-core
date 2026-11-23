import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSON_DELETED = "people.person.deleted";
const PERSON_RESTORED = "people.person.restored";

export type LockPersonForDeleteInput = {
  personId: string;
  version: number;
};

export type LockPersonForDeleteResult = {
  personId: string;
  version: number;
};

export type HidePersonInput = {
  personId: string;
  actorUserId: string;
};

export type HidePersonResult = {
  personId: string;
  version: number;
  purgeAfter: Date;
};

export type RestorePersonInput = {
  personId: string;
  version: number;
  actorUserId: string;
};

export type RestorePersonResult = {
  personId: string;
  version: number;
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

export async function lockPersonForDelete(
  tx: AppTransaction,
  input: LockPersonForDeleteInput,
): Promise<LockPersonForDeleteResult> {
  if (
    typeof input.personId !== "string" ||
    !UUID_RE.test(input.personId) ||
    typeof input.version !== "number" ||
    !Number.isInteger(input.version) ||
    input.version < 1
  ) {
    throw new PeopleError("invalid_input");
  }

  // Pin 25: Delete locks the person FOR UPDATE
  // Pin 28: Minor and other-tenant id are not found (is_minor = false and tenant scope)
  const rows = await tx<{ id: string; version: number }[]>`
    select id::text as id, version
    from app.persons
    where id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = false
      and deleted_at is null
    for update
  `;

  const person = rows[0];
  if (person === undefined) {
    throw new PeopleError("not_found");
  }

  if (person.version !== input.version) {
    throw new PeopleError("conflict");
  }

  return { personId: person.id, version: person.version };
}

export async function hidePerson(
  tx: AppTransaction,
  input: HidePersonInput,
): Promise<HidePersonResult> {
  if (
    typeof input.personId !== "string" ||
    !UUID_RE.test(input.personId) ||
    typeof input.actorUserId !== "string" ||
    !UUID_RE.test(input.actorUserId)
  ) {
    throw new PeopleError("invalid_input");
  }

  // Find the minor children of this contact. A child who has turned 18 keeps their
  // links but no longer needs a guardian, so only minors count (spec: Delete).
  const childLinks = await tx<{ child_person_id: string }[]>`
    select distinct gl.child_person_id::text as child_person_id
    from app.guardian_links gl
    join app.persons child
      on child.id = gl.child_person_id
     and child.org_id = gl.org_id
     and child.community_id = gl.community_id
    where gl.guardian_person_id = ${input.personId}::uuid
      and gl.org_id = current_setting('app.org_id')::uuid
      and gl.community_id = current_setting('app.community_id')::uuid
      and child.is_minor = true
    order by child_person_id::text asc
  `;

  if (childLinks.length > 0) {
    const childIds = childLinks.map((c) => c.child_person_id).sort();

    // Pin 26: Lock child rows FOR UPDATE in id order
    await tx`
      select id
      from app.persons
      where id = any(${childIds}::uuid[])
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
        and is_minor = true
      order by id asc
      for update
    `;

    // Pin 27: Sole guardian counts only unhidden other guardians (p.deleted_at is null)
    const otherGuardians = await tx<{ child_id: string; count: number }[]>`
      select gl.child_person_id::text as child_id, count(*)::int as count
      from app.guardian_links gl
      join app.persons p
        on p.id = gl.guardian_person_id
       and p.org_id = gl.org_id
       and p.community_id = gl.community_id
      where gl.child_person_id = any(${childIds}::uuid[])
        and gl.guardian_person_id <> ${input.personId}::uuid
        and gl.org_id = current_setting('app.org_id')::uuid
        and gl.community_id = current_setting('app.community_id')::uuid
        and p.deleted_at is null
      group by gl.child_person_id
    `;

    const otherCountByChild = new Map(otherGuardians.map((r) => [r.child_id, r.count]));
    for (const childId of childIds) {
      if ((otherCountByChild.get(childId) ?? 0) === 0) {
        throw new PeopleError("sole_guardian");
      }
    }
  }

  const updated = await tx<{ id: string; version: number; purge_after: Date }[]>`
    update app.persons
    set deleted_at = now(),
        deleted_by = ${input.actorUserId}::uuid,
        version = version + 1
    where id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = false
      and deleted_at is null
    returning
      id::text as id,
      version,
      (deleted_at + interval '720 hours') as purge_after
  `;

  const row = updated[0];
  if (row === undefined) {
    throw new PeopleError("not_found");
  }

  // Pin 30: Deleted audit event, person id only
  const rec = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: rec.actorKind,
    actorId: rec.actorId,
    action: PERSON_DELETED,
    purpose: PERSON_DELETED,
    targetIds: [input.personId],
  });

  return {
    personId: row.id,
    version: row.version,
    purgeAfter: row.purge_after,
  };
}

export async function restorePerson(
  tx: AppTransaction,
  input: RestorePersonInput,
): Promise<RestorePersonResult> {
  if (
    typeof input.personId !== "string" ||
    !UUID_RE.test(input.personId) ||
    typeof input.version !== "number" ||
    !Number.isInteger(input.version) ||
    input.version < 1 ||
    typeof input.actorUserId !== "string" ||
    !UUID_RE.test(input.actorUserId)
  ) {
    throw new PeopleError("invalid_input");
  }

  const rows = await tx<{ id: string; version: number }[]>`
    select id::text as id, version
    from app.persons
    where id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = false
      and deleted_at is not null
      and deleted_at > now() - interval '720 hours'
    for update
  `;

  const person = rows[0];
  if (person === undefined) {
    throw new PeopleError("not_found");
  }

  // Pin 29: Version checked on restore
  if (person.version !== input.version) {
    throw new PeopleError("conflict");
  }

  const updated = await tx<{ id: string; version: number }[]>`
    update app.persons
    set deleted_at = null,
        deleted_by = null,
        version = version + 1
    where id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    returning id::text as id, version
  `;

  const row = updated[0]!;

  // Pin 30: Restored audit event, person id only
  const rec = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: rec.actorKind,
    actorId: rec.actorId,
    action: PERSON_RESTORED,
    purpose: PERSON_RESTORED,
    targetIds: [input.personId],
  });

  return {
    personId: row.id,
    version: row.version,
  };
}
