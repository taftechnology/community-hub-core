import { defineAuditAction, defineAuditPurpose } from "@community-hub/kernel/module";

defineAuditAction("people.household.created");
defineAuditPurpose("people.household.created");
defineAuditAction("people.household.read");
defineAuditPurpose("people.household.read");
defineAuditAction("people.person.created");
defineAuditPurpose("people.person.created");
defineAuditAction("people.person.read");
defineAuditPurpose("people.person.read");

export { PeopleError } from "../domain/error.js";
export { ensureCommunityKey, ensureOrganisationKey } from "../infrastructure/keys.js";
export { createHousehold, readHousehold } from "../infrastructure/household.js";
export { createPerson, readPerson } from "../infrastructure/person.js";
export { linkGuardian, unlinkGuardian } from "../infrastructure/guardian.js";
