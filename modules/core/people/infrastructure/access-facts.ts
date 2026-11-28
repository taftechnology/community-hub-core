import type { AppTransaction } from "@community-hub/db";

export async function personIsMinor(
  tx: AppTransaction,
  personId: string,
  options?: { lock?: "share" },
): Promise<boolean | null> {
  const rows =
    options?.lock === "share"
      ? await tx<{ is_minor: boolean }[]>`
          select is_minor
          from app.persons
          where id = ${personId}::uuid
            and org_id = current_setting('app.org_id')::uuid
            and community_id = current_setting('app.community_id')::uuid
            and deleted_at is null
          for share
        `
      : await tx<{ is_minor: boolean }[]>`
          select is_minor
          from app.persons
          where id = ${personId}::uuid
            and org_id = current_setting('app.org_id')::uuid
            and community_id = current_setting('app.community_id')::uuid
            and deleted_at is null
        `;
  const row = rows[0];
  return row === undefined ? null : row.is_minor;
}

export async function hasGuardianView(
  tx: AppTransaction,
  guardianPersonId: string,
  childPersonId: string,
): Promise<boolean> {
  const rows = await tx<{ view: boolean }[]>`
    select view
    from app.guardian_links
    where guardian_person_id = ${guardianPersonId}::uuid
      and child_person_id = ${childPersonId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  return rows[0]?.view === true;
}

// Whether a family has a child, hidden children included until they are purged: the set the family
// label check reads. With lock "update" the family is locked first, as renameHousehold locks it. A
// child being added holds a share lock on the family (createPerson), so the answer waits for that
// child to be committed and counts them. A family that is not visible answers false.
export async function householdHasMinor(
  tx: AppTransaction,
  householdId: string,
  options?: { lock?: "update" },
): Promise<boolean> {
  if (options?.lock === "update") {
    await tx`
      select id
      from app.households
      where id = ${householdId}::uuid
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
        and deleted_at is null
      for no key update
    `;
  }
  const rows = await tx<{ found: boolean }[]>`
    select exists (
      select 1
      from app.persons p
      join app.households h
        on h.id = p.household_id
       and h.org_id = p.org_id
       and h.community_id = p.community_id
      where h.id = ${householdId}::uuid
        and h.org_id = current_setting('app.org_id')::uuid
        and h.community_id = current_setting('app.community_id')::uuid
        and h.deleted_at is null
        and p.is_minor = true
    ) as found
  `;
  return rows[0]?.found === true;
}

// Whether the child end of a guardian link is a minor; null when the family has no such link. A
// hidden child counts, because unlinkGuardian reaches their link too.
export async function guardianLinkChildIsMinor(
  tx: AppTransaction,
  input: { householdId: string; linkId: string },
): Promise<boolean | null> {
  const rows = await tx<{ is_minor: boolean }[]>`
    select p.is_minor
    from app.guardian_links gl
    join app.persons p
      on p.id = gl.child_person_id
     and p.org_id = gl.org_id
     and p.community_id = gl.community_id
    where gl.id = ${input.linkId}::uuid
      and gl.household_id = ${input.householdId}::uuid
      and gl.org_id = current_setting('app.org_id')::uuid
      and gl.community_id = current_setting('app.community_id')::uuid
  `;
  const row = rows[0];
  return row === undefined ? null : row.is_minor;
}

// Whether a life event is a minor's; null when there is no such event, or its person is hidden,
// which updateLifeEvent answers as not found.
export async function lifeEventPersonIsMinor(
  tx: AppTransaction,
  eventId: string,
): Promise<boolean | null> {
  const rows = await tx<{ is_minor: boolean }[]>`
    select p.is_minor
    from app.life_events e
    join app.persons p
      on p.id = e.person_id
     and p.org_id = e.org_id
     and p.community_id = e.community_id
    where e.id = ${eventId}::uuid
      and e.org_id = current_setting('app.org_id')::uuid
      and e.community_id = current_setting('app.community_id')::uuid
      and p.deleted_at is null
  `;
  const row = rows[0];
  return row === undefined ? null : row.is_minor;
}
