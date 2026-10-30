import { accessTables, rememberPersonKey } from "../../modules/core/access/db/schema.js";
import { billingTables } from "../../modules/core/billing/db/schema.js";
import {
  entitlementTables,
  rememberPlatformTables,
} from "../../modules/core/entitlements/db/schema.js";
import { identityTables } from "../../modules/core/identity/db/schema.js";
import { peopleTables } from "../../modules/core/people/db/schema.js";
import { platformTables } from "../../modules/core/tenancy/db/schema.js";
import { usageTables } from "../../modules/core/usage/db/schema.js";
import { groupsTables } from "../../modules/features/groups/db/schema.js";
import { blindIndexColumn, encryptedColumn } from "./src/columns.js";
import { app as appNamespace, identity, platform } from "./src/namespaces.js";

export { auditEvents, app, identity, platform, outbox } from "./src/schema.js";

const platformRows = platformTables(platform);

export const organisations = platformRows.organisations;
export const communities = platformRows.communities;

rememberPlatformTables({
  organisationId: organisations.id,
  communityId: communities.id,
});
const entitlementRows = entitlementTables(platform);

export const plans = entitlementRows.plans;
export const planEntitlements = entitlementRows.planEntitlements;
export const addOns = entitlementRows.addOns;
export const addOnEntitlements = entitlementRows.addOnEntitlements;
export const organisationPlans = entitlementRows.organisationPlans;
export const organisationAddOns = entitlementRows.organisationAddOns;
export const communityAllocations = entitlementRows.communityAllocations;
export const communityToggles = entitlementRows.communityToggles;
export const entitlementOverrides = entitlementRows.entitlementOverrides;
export const featureFlags = entitlementRows.featureFlags;

const billingRows = billingTables(platform, { organisationId: organisations.id });

export const billingAccounts = billingRows.billingAccounts;
export const billingSettings = billingRows.billingSettings;
export const billingStripeEvents = billingRows.billingStripeEvents;

const identityRows = identityTables(identity);

export const identityUsers = identityRows.users;
export const identityKeys = identityRows.identityKeys;
export const otpChallenges = identityRows.otpChallenges;
export const passkeyCredentials = identityRows.passkeyCredentials;
export const passkeyChallenges = identityRows.passkeyChallenges;
export const identitySessions = identityRows.sessions;
export const operatorGrants = identityRows.operatorGrants;
export const operatorEvents = identityRows.operatorEvents;

const peopleRows = peopleTables(appNamespace, { encryptedColumn, blindIndexColumn });

export const organisationKeys = peopleRows.organisationKeys;
export const communityKeys = peopleRows.communityKeys;
export const householdKeys = peopleRows.householdKeys;
export const households = peopleRows.households;
export const persons = peopleRows.persons;
export const guardianLinks = peopleRows.guardianLinks;
export const personTags = peopleRows.personTags;
export const personTagLinks = peopleRows.personTagLinks;
export const personActivity = peopleRows.personActivity;

rememberPersonKey(persons);
const accessRows = accessTables(appNamespace);

export const organisationRoleGrants = accessRows.organisationRoleGrants;
export const communityRoleGrants = accessRows.communityRoleGrants;
export const customRoles = accessRows.customRoles;
export const customRolePermissions = accessRows.customRolePermissions;
export const userLinks = accessRows.userLinks;

const usageRows = usageTables(appNamespace);

export const usageFactsDaily = usageRows.usageFactsDaily;

const groupRows = groupsTables(appNamespace, { persons });

export const groups = groupRows.groups;
export const groupMembers = groupRows.groupMembers;
