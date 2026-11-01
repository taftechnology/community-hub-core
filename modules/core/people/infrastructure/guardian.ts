import { appendAuditEvent, newId, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUARDIAN_LINKED = "people.guardian.linked";
const GUARDIAN_UNLINKED = "people.guardian.unlinked";

export type GuardianInput = {
  now: Date;
  householdId: string;
  guardianPersonId: string;
  childPersonId: string;
  consent: boolean;
  pickup: boolean;
  view: boolean;
  manage: boolean;
  actorUserId: string | null;
};

export type UnlinkGuardianInput = {
  now: Date;
  householdId: string;
  linkId: string;
  actorUserId: string | null;
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

function duplicateLink(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      typeof current.constraint_name === "string" &&
      current.constraint_name.includes("guardian")
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

async function householdExists(tx: AppTransaction, householdId: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    select id::text as id
    from app.households
    where id = ${householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  return rows[0] !== undefined;
}

export async function linkGuardian(
  tx: AppTransaction,
  input: GuardianInput,
): Promise<{ linkId: string }> {
  if (!input.consent && !input.pickup && !input.view && !input.manage) {
    throw new PeopleError("invalid_guardian");
  }
  if (
    typeof input.householdId !== "string" ||
    !UUID_RE.test(input.householdId) ||
    typeof input.guardianPersonId !== "string" ||
    !UUID_RE.test(input.guardianPersonId) ||
    typeof input.childPersonId !== "string" ||
    !UUID_RE.test(input.childPersonId)
  ) {
    throw new PeopleError("invalid_input");
  }

  const household = await householdExists(tx, input.householdId);
  if (!household) {
    throw new PeopleError("not_found");
  }

  // Pin 23: Lock both guardian and child rows in sorted order with for share
  const [firstId, secondId] = [input.guardianPersonId, input.childPersonId].sort();
  const members = await tx<{ id: string; is_minor: boolean; household_id: string | null }[]>`
    select id::text as id, is_minor, household_id::text as household_id
    from app.persons
    where id in (${firstId}::uuid, ${secondId}::uuid)
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    order by id asc
    for share
  `;

  const guardian = members.find((m) => m.id === input.guardianPersonId);
  const child = members.find((m) => m.id === input.childPersonId);

  if (guardian === undefined || child === undefined) {
    throw new PeopleError("not_found");
  }
  if (
    guardian.is_minor ||
    !child.is_minor ||
    guardian.household_id !== input.householdId ||
    child.household_id !== input.householdId
  ) {
    throw new PeopleError("invalid_guardian");
  }

  const linkId = newId();
  try {
    await tx.savepoint("guardian_link", async (sp) => {
      await sp`
        insert into app.guardian_links (
          id, org_id, community_id, household_id, guardian_person_id, child_person_id,
          consent, pickup, view, manage
        ) values (
          ${linkId}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${input.householdId}::uuid,
          ${input.guardianPersonId}::uuid,
          ${input.childPersonId}::uuid,
          ${input.consent},
          ${input.pickup},
          ${input.view},
          ${input.manage}
        )
      `;
      const activityId = newId();
      await sp`
        insert into app.person_activity (
          id, org_id, community_id, person_id, actor_user_id, kind, occurred_at
        ) values (
          ${activityId}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${input.childPersonId}::uuid,
          ${input.actorUserId}::uuid,
          'guardian_linked',
          ${input.now}
        )
      `;
    });
  } catch (error) {
    if (duplicateLink(error)) {
      throw new PeopleError("duplicate_guardian_link");
    }
    throw error;
  }

  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: GUARDIAN_LINKED,
    purpose: GUARDIAN_LINKED,
    targetIds: [linkId, input.childPersonId, input.guardianPersonId],
  });

  return { linkId };
}

export async function unlinkGuardian(
  tx: AppTransaction,
  input: UnlinkGuardianInput,
): Promise<void> {
  if (
    typeof input.householdId !== "string" ||
    !UUID_RE.test(input.householdId) ||
    typeof input.linkId !== "string" ||
    !UUID_RE.test(input.linkId)
  ) {
    throw new PeopleError("invalid_input");
  }

  // Pin 4 & 12: Verify link belongs to the named household and tenant scope
  const links = await tx<{ id: string; child_person_id: string }[]>`
    select id::text as id, child_person_id::text as child_person_id
    from app.guardian_links
    where id = ${input.linkId}::uuid
      and household_id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const link = links[0];
  if (link === undefined) {
    throw new PeopleError("not_found");
  }

  // Pin 3: Lock the child person row for update
  const lockedChild = await tx<{ id: string }[]>`
    select id::text as id
    from app.persons
    where id = ${link.child_person_id}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    for update
  `;
  if (lockedChild[0] === undefined) {
    throw new PeopleError("not_found");
  }

  // Pin 3: Count remaining links in the same transaction; refuse if <= 1
  const linkCounts = await tx<{ count: number }[]>`
    select count(*)::int as count
    from app.guardian_links
    where child_person_id = ${link.child_person_id}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const count = linkCounts[0]?.count ?? 0;
  if (count <= 1) {
    throw new PeopleError("last_guardian");
  }

  await tx`
    delete from app.guardian_links
    where id = ${input.linkId}::uuid
      and household_id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;

  const activityId = newId();
  await tx`
    insert into app.person_activity (
      id, org_id, community_id, person_id, actor_user_id, kind, occurred_at
    ) values (
      ${activityId}::uuid,
      current_setting('app.org_id')::uuid,
      current_setting('app.community_id')::uuid,
      ${link.child_person_id}::uuid,
      ${input.actorUserId}::uuid,
      'guardian_unlinked',
      ${input.now}
    )
  `;

  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: GUARDIAN_UNLINKED,
    purpose: GUARDIAN_UNLINKED,
    targetIds: [input.linkId, link.child_person_id],
  });
}
