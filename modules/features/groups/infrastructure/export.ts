import type { KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";
import { readRosterNames, type ChildView } from "@community-hub/people";

import { toCsv } from "../domain/csv.js";
import { GroupsError } from "../domain/error.js";
import { isChildView } from "./child-view.js";
import type { GroupMemberRole } from "./members.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExportRosterCsvInput {
  groupId: string;
  // Required, with no default. Under "presence" children are left out of the file. Under "admin"
  // a child is one row with its label and no name. A child's field is never decrypted.
  childView: ChildView;
  actorUserId: string;
}

export async function exportRosterCsv(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ExportRosterCsvInput,
): Promise<string> {
  if (
    typeof input.groupId !== "string" ||
    !UUID_RE.test(input.groupId) ||
    typeof input.actorUserId !== "string" ||
    !UUID_RE.test(input.actorUserId) ||
    !isChildView(input.childView)
  ) {
    throw new GroupsError("invalid_input");
  }

  const groupRows = await tx<{ id: string }[]>`
    select id::text as id
    from app.groups
    where id = ${input.groupId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  if (groupRows[0] === undefined) {
    throw new GroupsError("group_not_found");
  }

  const memberRows = await tx<{ person_id: string; role: string }[]>`
    select person_id::text as person_id, role
    from app.group_members
    where group_id = ${input.groupId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;

  const header = ["given_name", "family_name", "role"];

  if (memberRows.length === 0) {
    const csv = toCsv([header]);
    await appendAuditEvent(tx, {
      actorKind: "user",
      actorId: input.actorUserId,
      action: "groups.roster.exported",
      purpose: "groups.roster.exported",
      targetIds: [input.groupId],
    });
    return csv;
  }

  const personIds = memberRows.map((m) => m.person_id);
  const roster = await readRosterNames(tx, kms, keyArn, {
    personIds,
    childView: input.childView,
    actorUserId: input.actorUserId,
  });

  const adultByPersonId = new Map<string, (typeof roster.adults)[number]>();
  for (const person of roster.adults) {
    adultByPersonId.set(person.personId, person);
  }
  const labelByPersonId = new Map<string, string>();
  for (const child of roster.children) {
    labelByPersonId.set(child.personId, child.label);
  }

  interface AdultRow {
    personId: string;
    givenName: string;
    familyName: string;
    role: GroupMemberRole;
  }
  interface ChildRow {
    personId: string;
    label: string;
    role: GroupMemberRole;
  }

  // A member who is neither in the adults nor in the children is hidden, or is a child under
  // "presence": either way it is not in the file.
  const adults: AdultRow[] = [];
  const children: ChildRow[] = [];
  for (const member of memberRows) {
    const adult = adultByPersonId.get(member.person_id);
    if (adult !== undefined) {
      adults.push({
        personId: member.person_id,
        givenName: adult.givenName,
        familyName: adult.familyName,
        role: member.role as GroupMemberRole,
      });
      continue;
    }
    const label = labelByPersonId.get(member.person_id);
    if (label !== undefined) {
      children.push({ personId: member.person_id, label, role: member.role as GroupMemberRole });
    }
  }

  adults.sort((a, b) => {
    const fam = a.familyName.localeCompare(b.familyName, "en", { sensitivity: "variant" });
    if (fam !== 0) return fam;
    const giv = a.givenName.localeCompare(b.givenName, "en", { sensitivity: "variant" });
    if (giv !== 0) return giv;
    return a.personId < b.personId ? -1 : 1;
  });
  // Children follow the adults, by label ("Child 2" before "Child 10") and then by person id.
  children.sort((a, b) => {
    const label = a.label.localeCompare(b.label, "en", { numeric: true });
    if (label !== 0) return label;
    return a.personId < b.personId ? -1 : 1;
  });

  const rows = [
    ...adults.map((a) => [a.givenName, a.familyName, a.role]),
    // The label alone, in the first column. A child's name is never read, so there is none.
    ...children.map((c) => [c.label, "", c.role]),
  ];
  const csv = toCsv([header, ...rows]);

  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: input.actorUserId,
    action: "groups.roster.exported",
    purpose: "groups.roster.exported",
    targetIds: [input.groupId],
  });

  return csv;
}
