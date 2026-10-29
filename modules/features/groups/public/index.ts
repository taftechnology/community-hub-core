import { defineAuditAction, defineAuditPurpose } from "@community-hub/kernel/module";

defineAuditAction("groups.group.created");
defineAuditPurpose("groups.group.created");
defineAuditAction("groups.group.updated");
defineAuditPurpose("groups.group.updated");
defineAuditAction("groups.group.archived");
defineAuditPurpose("groups.group.archived");
defineAuditAction("groups.member.added");
defineAuditPurpose("groups.member.added");
defineAuditAction("groups.member.removed");
defineAuditPurpose("groups.member.removed");
defineAuditAction("groups.member.role_changed");
defineAuditPurpose("groups.member.role_changed");
defineAuditAction("groups.roster.exported");
defineAuditPurpose("groups.roster.exported");

export { GroupsError } from "../domain/error.js";
export {
  createGroup,
  updateGroup,
  archiveGroup,
  restoreGroup,
  listGroups,
  readGroup,
  type GroupKind,
  type GroupStatus,
  type GroupRecord,
  type CreateGroupInput,
  type UpdateGroupInput,
  type ArchiveGroupInput,
  type RestoreGroupInput,
  type ListGroupsOptions,
} from "../infrastructure/groups.js";
