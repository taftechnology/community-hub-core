import { defineAuditAction, defineAuditPurpose } from "@community-hub/kernel/module";

defineAuditAction("people.household.created");
defineAuditPurpose("people.household.created");
defineAuditAction("people.household.read");
defineAuditPurpose("people.household.read");

export { PeopleError } from "../domain/error.js";
export { ensureCommunityKey, ensureOrganisationKey } from "../infrastructure/keys.js";
export { createHousehold, readHousehold } from "../infrastructure/household.js";
