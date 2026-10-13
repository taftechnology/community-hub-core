import { defineAuditAction, defineAuditPurpose } from "@community-hub/kernel/module";

defineAuditAction("entitlements.permission.denied");
defineAuditAction("entitlements.toggle.changed");
defineAuditPurpose("entitlements.toggles.view");
defineAuditPurpose("entitlements.toggles.manage");

export { EntitlementError } from "../domain/error.js";
export {
  allocate,
  assignPlan,
  grantOverride,
  setFeatureFlag,
  upsertAddOn,
  upsertPlan,
} from "../infrastructure/writes.js";
export { readSnapshot } from "../infrastructure/snapshot.js";
export { setToggle } from "../infrastructure/toggle.js";
