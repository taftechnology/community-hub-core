import { appendAuditEvent, type AppTransaction } from "@community-hub/db";
import { hasGuardianView, readPerson } from "@community-hub/people";
import { decide } from "@community-hub/policy";

import { AccessError } from "../domain/error.js";
import { parseUuid } from "../domain/role.js";
import { loadActor } from "./grants.js";

const DENIED = "access.permission.denied";
const RESTRICTED = "people.restricted.read";

type ReadPerson = typeof readPerson;

export async function readPersonForActor(
  tx: AppTransaction,
  kms: Parameters<ReadPerson>[1],
  keyArn: Parameters<ReadPerson>[2],
  input: { personId: string; actorUserId: string },
): ReturnType<ReadPerson> {
  const personId = parseUuid(input.personId);
  const actorUserId = parseUuid(input.actorUserId);
  const actor = await loadActor(tx, actorUserId);
  const links = await tx<{ person_id: string }[]>`
    select person_id::text as person_id
    from app.user_links
    where user_id = ${actorUserId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const guardianPersonId = links[0]?.person_id;
  const guardianView =
    guardianPersonId === undefined ? false : await hasGuardianView(tx, guardianPersonId, personId);
  const allowed = decide({
    permission: RESTRICTED,
    organisationRoleKeys: actor.organisationRoleKeys,
    communityRoleKeys: actor.communityRoleKeys,
    customPermissions: actor.customPermissions,
    guardianView,
    personScoped: true,
  });
  if (!allowed) {
    await appendAuditEvent(tx, {
      actorKind: "user",
      actorId: actorUserId,
      action: DENIED,
      purpose: RESTRICTED,
      targetIds: [personId],
    });
    throw new AccessError("forbidden");
  }
  return readPerson(tx, kms, keyArn, { personId, actorUserId });
}
