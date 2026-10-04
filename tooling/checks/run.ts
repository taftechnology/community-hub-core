import { check as checkEventNames } from "./event-names/check.js";
import { check as checkTokens } from "./tokens/check.js";
import { check as checkSchemaRls } from "./schema-rls/check.js";
import { check as checkSqlSessionBan } from "./sql-session-ban/check.js";
import { check as checkTerraformInvariants } from "./terraform-invariants/check.js";

let failed = false;

const schemaResult = checkSchemaRls();
if (schemaResult.notice) {
  console.log(schemaResult.notice);
}
if (!schemaResult.ok) {
  for (const v of schemaResult.violations) {
    console.error(`${v.file} app.${v.table}: ${v.message}`);
  }
  failed = true;
} else if (schemaResult.appTableCount > 0) {
  console.log("schema-rls: ok");
}

const terraformResult = checkTerraformInvariants();
if (terraformResult.notice) {
  console.log(terraformResult.notice);
}
if (!terraformResult.ok) {
  for (const v of terraformResult.violations) {
    console.error(`${v.file}: ${v.message}`);
  }
  failed = true;
} else if (!terraformResult.notice) {
  console.log("terraform-invariants: ok");
}

const sqlSessionResult = checkSqlSessionBan();
if (!sqlSessionResult.ok) {
  for (const v of sqlSessionResult.violations) {
    console.error(`${v.file}: ${v.message}`);
  }
  failed = true;
} else {
  console.log("sql-session-ban: ok");
}

const eventNamesResult = checkEventNames();
if (eventNamesResult.notice) {
  console.log(eventNamesResult.notice);
}
if (!eventNamesResult.ok) {
  for (const v of eventNamesResult.violations) {
    console.error(`${v.file}: ${v.message}`);
  }
  failed = true;
} else {
  console.log("event-names: ok");
}

const tokensResult = await checkTokens(process.cwd());
if (!tokensResult.ok) {
  for (const v of tokensResult.violations) {
    console.error(`${v.id}: ${v.message}`);
  }
  failed = true;
} else {
  console.log("tokens: ok");
}

process.exit(failed ? 1 : 0);
