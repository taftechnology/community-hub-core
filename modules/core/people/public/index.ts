import { defineAuditAction, defineAuditPurpose } from "@community-hub/kernel/module";

defineAuditAction("people.household.created");
defineAuditPurpose("people.household.created");
defineAuditAction("people.household.read");
defineAuditPurpose("people.household.read");
defineAuditAction("people.household.listed");
defineAuditPurpose("people.household.listed");
defineAuditAction("people.household.updated");
defineAuditPurpose("people.household.updated");
defineAuditAction("people.person.household_moved");
defineAuditPurpose("people.person.household_moved");
defineAuditAction("people.guardian.linked");
defineAuditPurpose("people.guardian.linked");
defineAuditAction("people.guardian.unlinked");
defineAuditPurpose("people.guardian.unlinked");
defineAuditAction("people.person.created");
defineAuditPurpose("people.person.created");
defineAuditAction("people.person.read");
defineAuditPurpose("people.person.read");
defineAuditAction("people.person.listed");
defineAuditPurpose("people.person.listed");
defineAuditAction("people.person.listed_minors");
defineAuditPurpose("people.person.listed_minors");
defineAuditAction("people.person.updated");
defineAuditPurpose("people.person.updated");
defineAuditAction("people.person.status_changed");
defineAuditPurpose("people.person.status_changed");
defineAuditAction("people.permission.denied");
defineAuditPurpose("people.permission.denied");
defineAuditPurpose("people.person.manage");
defineAuditAction("people.life_event.listed");
defineAuditPurpose("people.life_event.listed");
defineAuditAction("people.life_event.created");
defineAuditPurpose("people.life_event.created");
defineAuditAction("people.life_event.updated");
defineAuditPurpose("people.life_event.updated");
defineAuditAction("people.person.purged");
defineAuditPurpose("people.person.purged");
defineAuditAction("people.household.purged");
defineAuditPurpose("people.household.purged");
defineAuditAction("people.household.deleted");
defineAuditPurpose("people.household.deleted");
defineAuditAction("people.household.restored");
defineAuditPurpose("people.household.restored");
defineAuditAction("people.household.status_changed");
defineAuditPurpose("people.household.status_changed");
defineAuditAction("people.household.listed_deleted");
defineAuditPurpose("people.household.listed_deleted");
defineAuditAction("people.person.deleted");
defineAuditPurpose("people.person.deleted");
defineAuditAction("people.person.restored");
defineAuditPurpose("people.person.restored");
defineAuditAction("people.person.listed_deleted");
defineAuditPurpose("people.person.listed_deleted");

export { PeopleError } from "../domain/error.js";
export { ensureCommunityKey, ensureOrganisationKey } from "../infrastructure/keys.js";
export {
  createHousehold,
  openHouseholdLabel,
  readHousehold,
  readHouseholdDetail,
  renameHousehold,
  type HouseholdAdultMember,
  type HouseholdGuardianLink,
  type HouseholdMinorMember,
  type ReadHouseholdDetailInput,
  type ReadHouseholdDetailResult,
  type RenameHouseholdInput,
} from "../infrastructure/household.js";
export {
  listDeletedHouseholds,
  listHouseholds,
  type DeletedHouseholdListItem,
  type HouseholdListItem,
  type ListDeletedHouseholdsInput,
  type ListDeletedHouseholdsResult,
  type ListHouseholdsInput,
  type ListHouseholdsResult,
} from "../infrastructure/household-list.js";
export { createPerson, readPerson } from "../infrastructure/person.js";
export {
  setPersonStatus,
  type SetPersonStatusInput,
  type SetPersonStatusResult,
} from "../infrastructure/person-status.js";
export {
  summarisePersons,
  type SummarisePersonsInput,
  type SummarisePersonsResult,
} from "../infrastructure/person-summary.js";
export {
  updatePerson,
  type UpdatePersonChanges,
  type UpdatePersonInput,
  type UpdatePersonResult,
} from "../infrastructure/update-person.js";
export {
  listDeletedPersons,
  listPersons,
  type DeletedPersonListItem,
  type ListDeletedPersonsInput,
  type ListDeletedPersonsResult,
  type ListPersonsInput,
  type ListPersonsResult,
  type PersonListItem,
} from "../infrastructure/list-persons.js";
export { hasGuardianView, personIsMinor } from "../infrastructure/access-facts.js";
export {
  moveAdult,
  addMinor,
  addAdult,
  type MoveAdultInput,
  type AddMinorInput,
  type AddAdultInput,
} from "../infrastructure/household-members.js";
export {
  linkGuardian,
  unlinkGuardian,
  type GuardianInput,
  type UnlinkGuardianInput,
} from "../infrastructure/guardian.js";
export { listPersonActivity } from "../infrastructure/activity.js";
export { attachTag, createTag, detachTag, listPersonTags } from "../infrastructure/tags.js";
export { openPersonFieldKeys } from "../infrastructure/person-keys.js";
export { readRosterNames, visiblePersonIds } from "../infrastructure/roster-names.js";
export {
  readLinkedContacts,
  type LinkedContact,
  type ReadLinkedContactsInput,
} from "../infrastructure/linked-contacts.js";
export {
  createLifeEvent,
  listLifeEvents,
  updateLifeEvent,
  type CreateLifeEventInput,
  type CreateLifeEventResult,
  type LifeEventItem,
  type ListLifeEventsInput,
  type ListLifeEventsResult,
  type UpdateLifeEventInput,
  type UpdateLifeEventResult,
} from "../infrastructure/life-event.js";
export { purgeDeletedPersons } from "../infrastructure/purge.js";
export { purgeDeletedHouseholds } from "../infrastructure/household-purge.js";
export {
  hidePerson,
  lockPersonForDelete,
  restorePerson,
  type HidePersonInput,
  type HidePersonResult,
  type LockPersonForDeleteInput,
  type LockPersonForDeleteResult,
  type RestorePersonInput,
  type RestorePersonResult,
} from "../infrastructure/person-delete.js";
export {
  hideHousehold,
  restoreHousehold,
  type HideHouseholdInput,
  type HideHouseholdResult,
  type RestoreHouseholdInput,
  type RestoreHouseholdResult,
} from "../infrastructure/household-delete.js";
export {
  setHouseholdStatus,
  type HouseholdStatus,
  type SetHouseholdStatusInput,
  type SetHouseholdStatusResult,
} from "../infrastructure/household-status.js";
