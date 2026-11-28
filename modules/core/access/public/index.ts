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
// The Community Admin's View of one child field (ADR 0017). The action is written once per View,
// with the purpose of the field viewed. Three segments each: the audit table's check allows no more.
defineAuditAction("people.minor.field_viewed");
defineAuditPurpose("people.minor_view.name");
defineAuditPurpose("people.minor_view.date_of_birth");
defineAuditPurpose("people.minor_view.email");
defineAuditPurpose("people.minor_view.phone");
defineAuditPurpose("people.minor_view.life_event_type");
defineAuditPurpose("people.minor_view.life_event_date");
defineAuditPurpose("people.minor_view.life_event_place");
defineAuditPurpose("people.minor_view.life_event_notes");

export { AccessError } from "../domain/error.js";
export type { InvitationAddresses } from "../domain/invitation-addresses.js";
export {
  type InvitationMail,
  InvitationMailUnavailable,
  rejectingInvitationMail,
} from "../domain/invitation-mail.js";
export { buildInvitationToken, parseInvitationToken } from "../domain/invitation-token.js";
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
export { isCommunityAdmin } from "../infrastructure/community-admin.js";
export {
  finishMinorView,
  prepareMinorView,
  type MinorViewInput,
  type MinorViewValue,
} from "../infrastructure/minor-view.js";
export {
  createInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  proveInvitation,
  acceptInvitation,
  deleteInvitationAfterMailFailure,
  voidInvitationAfterMailFailure,
  type CreateInvitationInput,
  type ListInvitationsInput,
  type InvitationListItem,
  type ResendInvitationInput,
  type RevokeInvitationInput,
  type ProveInvitationInput,
  type AcceptInvitationInput,
  type MailFailureInput,
} from "../infrastructure/invitations.js";
export { readPersonForActor } from "../infrastructure/restricted-read.js";
export { deleteBlockers, type DeleteBlockersResult } from "../infrastructure/delete-blockers.js";
