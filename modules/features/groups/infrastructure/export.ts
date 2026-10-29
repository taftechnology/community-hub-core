import type { KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";
import { readRosterNames } from "@community-hub/people";

import { toCsv } from "../domain/csv.js";
import { GroupsError } from "../domain/error.js";
import type { GroupMemberRole } from "./members.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExportRosterCsvInput {
  groupId: string;
  includeRestricted: boolean;
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
    typeof input.includeRestricted !== "boolean"
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
    includeRestricted: input.includeRestricted,
    actorUserId: input.actorUserId,
  });

  const rosterByPersonId = new Map<string, (typeof roster)[number]>();
  for (const person of roster) {
    rosterByPersonId.set(person.personId, person);
  }

  interface CandidateRow {
    personId: string;
    givenName: string;
    familyName: string;
    role: GroupMemberRole;
  }

  const candidates: CandidateRow[] = [];
  for (const member of memberRows) {
    const nameRecord = rosterByPersonId.get(member.person_id);
    if (!nameRecord) {
      continue;
    }
    if (nameRecord.isMinor && !input.includeRestricted) {
      continue;
    }
    candidates.push({
      personId: member.person_id,
      givenName: nameRecord.givenName,
      familyName: nameRecord.familyName,
      role: member.role as GroupMemberRole,
    });
  }

  candidates.sort((a, b) => {
    const fam = a.familyName.localeCompare(b.familyName, "en", { sensitivity: "variant" });
    if (fam !== 0) return fam;
    const giv = a.givenName.localeCompare(b.givenName, "en", { sensitivity: "variant" });
    if (giv !== 0) return giv;
    return a.personId.localeCompare(b.personId, "en", { sensitivity: "variant" });
  });

  const rows = candidates.map((c) => [c.givenName, c.familyName, c.role]);
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
