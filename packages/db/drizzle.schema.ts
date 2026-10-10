import { platformTables } from "../../modules/core/tenancy/db/schema.js";
import { platform } from "./src/namespaces.js";

export { auditEvents, app, identity, platform, outbox } from "./src/schema.js";

const tables = platformTables(platform);

export const organisations = tables.organisations;
export const communities = tables.communities;
