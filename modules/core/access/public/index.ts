import { defineAuditAction, defineAuditPurpose } from "@community-hub/kernel/module";

defineAuditAction("access.owner.bootstrapped");
defineAuditPurpose("access.owner.bootstrapped");
defineAuditAction("access.role.granted");
defineAuditPurpose("access.role.granted");
defineAuditAction("access.role.revoked");
defineAuditPurpose("access.role.revoked");
defineAuditAction("access.custom_role.created");
defineAuditPurpose("access.custom_role.created");
defineAuditAction("access.custom_role.deleted");
defineAuditPurpose("access.custom_role.deleted");
defineAuditAction("access.user.linked");
defineAuditPurpose("access.user.linked");
defineAuditAction("access.user.unlinked");
defineAuditPurpose("access.user.unlinked");
defineAuditAction("access.permission.denied");
defineAuditPurpose("access.permission.denied");
defineAuditPurpose("access.roles.manage");
defineAuditPurpose("access.roles.view");
defineAuditPurpose("access.users.manage");
defineAuditAction("access.users.listed");
defineAuditPurpose("access.users.listed");
defineAuditPurpose("access.users.view");
defineAuditAction("access.invitation.created");
defineAuditPurpose("access.invitation.created");
defineAuditAction("access.invitation.resent");
defineAuditPurpose("access.invitation.resent");
defineAuditAction("access.invitation.revoked");
defineAuditPurpose("access.invitation.revoked");
defineAuditAction("access.invitation.accepted");
defineAuditPurpose("access.invitation.accepted");
defineAuditAction("access.invitation.voided");
defineAuditPurpose("access.invitation.voided");
defineAuditAction("access.invitations.listed");
defineAuditPurpose("access.invitations.listed");
defineAuditPurpose("access.user.not_member");
defineAuditPurpose("people.person.view");
defineAuditPurpose("people.restricted.read");

export { AccessError } from "../domain/error.js";
export { createCustomRole, deleteCustomRole } from "../infrastructure/custom-roles.js";
export {
  grantRole,
  revokeRole,
  bootstrapOwner,
  findOwner,
  linkUser,
  unlinkUser,
} from "../infrastructure/grants.js";
export { holdsAnyGrant } from "../infrastructure/holds-any-grant.js";
export { holdsPermission } from "../infrastructure/holds-permission.js";
export { readPersonForActor } from "../infrastructure/restricted-read.js";
