import { newId, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";
import { normaliseTag } from "../domain/person.js";

type TagLinkInput = {
  now: Date;
  personId: string;
  tagId: string;
  actorUserId: string | null;
};

function duplicateTag(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === "23505") {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

async function personExists(tx: AppTransaction, personId: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    select id::text as id from app.persons where id = ${personId}::uuid
  `;
  return rows[0] !== undefined;
}

async function tagExists(tx: AppTransaction, tagId: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    select id::text as id from app.person_tags where id = ${tagId}::uuid
  `;
  return rows[0] !== undefined;
}

export async function createTag(
  tx: AppTransaction,
  input: { label: string },
): Promise<{ tagId: string }> {
  const label = normaliseTag(input.label);
  const tagId = newId();
  try {
    await tx.savepoint("person_tag", async (sp) => {
      await sp`
        insert into app.person_tags (id, org_id, community_id, label)
        values (
          ${tagId}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${label}
        )
      `;
    });
  } catch (error) {
    if (duplicateTag(error)) {
      throw new PeopleError("duplicate_tag");
    }
    throw error;
  }
  return { tagId };
}

export async function attachTag(tx: AppTransaction, input: TagLinkInput): Promise<void> {
  if (!(await personExists(tx, input.personId)) || !(await tagExists(tx, input.tagId))) {
    throw new PeopleError("not_found");
  }
  const activityId = newId();
  try {
    await tx.savepoint("tag_link", async (sp) => {
      await sp`
        insert into app.person_tag_links (org_id, community_id, person_id, tag_id)
        values (
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${input.personId}::uuid,
          ${input.tagId}::uuid
        )
      `;
      await sp`
        insert into app.person_activity (
          id, org_id, community_id, person_id, actor_user_id, kind, occurred_at
        ) values (
          ${activityId}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${input.personId}::uuid,
          ${input.actorUserId}::uuid,
          'tagged',
          ${input.now}
        )
      `;
    });
  } catch (error) {
    if (duplicateTag(error)) {
      throw new PeopleError("duplicate_tag");
    }
    throw error;
  }
}

export async function detachTag(tx: AppTransaction, input: TagLinkInput): Promise<void> {
  const removed = await tx<{ person_id: string }[]>`
    delete from app.person_tag_links
    where person_id = ${input.personId}::uuid and tag_id = ${input.tagId}::uuid
    returning person_id::text as person_id
  `;
  if (removed[0] === undefined) {
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
      ${input.personId}::uuid,
      ${input.actorUserId}::uuid,
      'untagged',
      ${input.now}
    )
  `;
}

export async function listPersonTags(
  tx: AppTransaction,
  personId: string,
): Promise<{ tagId: string; label: string }[] | null> {
  if (!(await personExists(tx, personId))) {
    return null;
  }
  const rows = await tx<{ tag_id: string; label: string }[]>`
    select tags.id::text as tag_id, tags.label
    from app.person_tag_links links
    join app.person_tags tags on tags.id = links.tag_id
    where links.person_id = ${personId}::uuid
  `;
  return rows
    .map((row) => ({ tagId: row.tag_id, label: row.label }))
    .sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));
}
