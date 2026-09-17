import { check as checkSchemaRls } from "./schema-rls/check.js";
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

process.exit(failed ? 1 : 0);
