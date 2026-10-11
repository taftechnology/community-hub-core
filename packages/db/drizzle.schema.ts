import { identityTables } from "../../modules/core/identity/db/schema.js";
import { platformTables } from "../../modules/core/tenancy/db/schema.js";
import { identity, platform } from "./src/namespaces.js";

export { auditEvents, app, identity, platform, outbox } from "./src/schema.js";

const platformRows = platformTables(platform);

export const organisations = platformRows.organisations;
export const communities = platformRows.communities;

const identityRows = identityTables(identity);

export const identityUsers = identityRows.users;
export const identityKeys = identityRows.identityKeys;
export const otpChallenges = identityRows.otpChallenges;
export const passkeyCredentials = identityRows.passkeyCredentials;
export const passkeyChallenges = identityRows.passkeyChallenges;
export const identitySessions = identityRows.sessions;
