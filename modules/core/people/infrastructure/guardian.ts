import { newId, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";

type GuardianInput = {
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

type Member = {
  is_minor: boolean;
  household_id: string | null;
};

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
    select id::text as id from app.households where id = ${householdId}::uuid
  `;
  return rows[0] !== undefined;
}

async function loadMember(tx: AppTransaction, personId: string): Promise<Member | undefined> {
  const rows = await tx<Member[]>`
    select is_minor, household_id::text as household_id
    from app.persons
    where id = ${personId}::uuid
  `;
  return rows[0];
}

export async function linkGuardian(
  tx: AppTransaction,
  input: GuardianInput,
): Promise<{ linkId: string }> {
  if (!input.consent && !input.pickup && !input.view && !input.manage) {
    throw new PeopleError("invalid_guardian");
  }
  const household = await householdExists(tx, input.householdId);
  const guardian = await loadMember(tx, input.guardianPersonId);
  const child = await loadMember(tx, input.childPersonId);
  if (!household || guardian === undefined || child === undefined) {
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
  return { linkId };
}

export async function unlinkGuardian(
  tx: AppTransaction,
  input: { now: Date; linkId: string; actorUserId: string | null },
): Promise<void> {
  const removed = await tx<{ child_person_id: string }[]>`
    delete from app.guardian_links
    where id = ${input.linkId}::uuid
    returning child_person_id::text as child_person_id
  `;
  const childPersonId = removed[0]?.child_person_id;
  if (childPersonId === undefined) {
    throw new PeopleError("not_found");
  }
  const activityId = newId();
  await tx`
    insert into app.person_activity (
      id, org_id, community_id, person_id, actor_user_id, kind, occurred_at
    ) values (
      ${activityId}::uuid,
      current_setting('app.org_id')::uuid,
      current_setting('app.community_id')::uuid,
      ${childPersonId}::uuid,
      ${input.actorUserId}::uuid,
      'guardian_unlinked',
      ${input.now}
    )
  `;
}
