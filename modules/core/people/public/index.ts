import { defineAuditAction, defineAuditPurpose } from "@community-hub/kernel/module";

defineAuditAction("people.household.created");
defineAuditPurpose("people.household.created");
defineAuditAction("people.household.read");
defineAuditPurpose("people.household.read");
defineAuditAction("people.person.created");
defineAuditPurpose("people.person.created");
defineAuditAction("people.person.read");
defineAuditPurpose("people.person.read");
defineAuditAction("people.person.listed_minors");
defineAuditPurpose("people.person.listed_minors");
defineAuditAction("people.person.updated");
defineAuditPurpose("people.person.updated");
defineAuditAction("people.permission.denied");
defineAuditPurpose("people.permission.denied");

export { PeopleError } from "../domain/error.js";
export { ensureCommunityKey, ensureOrganisationKey } from "../infrastructure/keys.js";
export { createHousehold, readHousehold } from "../infrastructure/household.js";
export { createPerson, readPerson } from "../infrastructure/person.js";
export {
  updatePerson,
  type UpdatePersonChanges,
  type UpdatePersonInput,
  type UpdatePersonResult,
} from "../infrastructure/update-person.js";
export {
  listPersons,
  type ListPersonsInput,
  type ListPersonsResult,
  type PersonListItem,
} from "../infrastructure/list-persons.js";
export { hasGuardianView, personIsMinor } from "../infrastructure/access-facts.js";
export { linkGuardian, unlinkGuardian } from "../infrastructure/guardian.js";
export { listPersonActivity } from "../infrastructure/activity.js";
export { attachTag, createTag, detachTag, listPersonTags } from "../infrastructure/tags.js";
export { openPersonFieldKeys } from "../infrastructure/person-keys.js";
export { readRosterNames } from "../infrastructure/roster-names.js";
