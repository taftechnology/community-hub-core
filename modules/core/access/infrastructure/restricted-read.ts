import { appendAuditEvent, type AppTransaction } from "@community-hub/db";
import { readPerson } from "@community-hub/people";
import { decide } from "@community-hub/policy";

import { AccessError } from "../domain/error.js";
import { parseUuid } from "../domain/role.js";
import { loadActor } from "./grants.js";

const DENIED = "access.permission.denied";
const RESTRICTED = "people.restricted.read";
const VIEW = "people.view";
const ADULT_VIEW_PURPOSE = "people.person.view";

type ReadPerson = typeof readPerson;

export async function readPersonForActor(
  tx: AppTransaction,
  kms: Parameters<ReadPerson>[1],
  keyArn: Parameters<ReadPerson>[2],
  input: { personId: string; actorUserId: string },
): ReturnType<ReadPerson> {
  const personId = parseUuid(input.personId);
  const actorUserId = parseUuid(input.actorUserId);

  const rows = await tx<{ is_minor: boolean }[]>`
    select is_minor
    from app.persons
    where id = ${personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and deleted_at is null
  `;
  const row = rows[0];
  if (row === undefined || row.is_minor) {
    await appendAuditEvent(tx, {
      actorKind: "user",
      actorId: actorUserId,
      action: DENIED,
      purpose: RESTRICTED,
      targetIds: [personId],
    });
    throw new AccessError("forbidden");
  }

  const actor = await loadActor(tx, actorUserId);
  const allowed =
    decide({
      permission: VIEW,
      organisationRoleKeys: actor.organisationRoleKeys,
      communityRoleKeys: actor.communityRoleKeys,
      customPermissions: actor.customPermissions,
      guardianView: false,
      personScoped: false,
    }) ||
    decide({
      permission: RESTRICTED,
      organisationRoleKeys: actor.organisationRoleKeys,
      communityRoleKeys: actor.communityRoleKeys,
      customPermissions: actor.customPermissions,
      guardianView: false,
      personScoped: false,
    });
  if (!allowed) {
    await appendAuditEvent(tx, {
      actorKind: "user",
      actorId: actorUserId,
      action: DENIED,
      purpose: ADULT_VIEW_PURPOSE,
      targetIds: [personId],
    });
    throw new AccessError("forbidden");
  }
  return readPerson(tx, kms, keyArn, { personId, actorUserId });
}
