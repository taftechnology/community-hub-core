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

export { AccessError } from "../domain/error.js";
