import { check as checkEventNames } from "./event-names/check.js";
import { check as checkResidencyCell } from "./residency-cell/check.js";
import { check as checkResidencyPayload } from "./residency-payload/check.js";
import { check as checkSchemaRls } from "./schema-rls/check.js";
import { check as checkSqlSessionBan } from "./sql-session-ban/check.js";
import { check as checkTerraformInvariants } from "./terraform-invariants/check.js";
import { check as checkWorkerConfig } from "./worker-config/check.js";

let failed = false;

const workerResult = checkWorkerConfig();
if (!workerResult.ok) {
  for (const v of workerResult.violations) {
    console.error(`${v.app}: ${v.message}`);
  }
  failed = true;
} else {
  console.log("worker-config: ok");
}

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

const residencyResult = checkResidencyPayload();
if (residencyResult.notice) {
  console.log(residencyResult.notice);
}
if (!residencyResult.ok) {
  for (const v of residencyResult.violations) {
    console.error(`${v.file} ${v.key}: ${v.message}`);
  }
  failed = true;
} else if (residencyResult.payloadFileCount > 0) {
  console.log("residency-payload: ok");
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

const residencyCellResult = checkResidencyCell();
if (residencyCellResult.notice) {
  console.log(residencyCellResult.notice);
}
if (!residencyCellResult.ok) {
  for (const v of residencyCellResult.violations) {
    console.error(`${v.file}: ${v.message}`);
  }
  failed = true;
} else {
  console.log("residency-cell: ok");
}

process.exit(failed ? 1 : 0);
