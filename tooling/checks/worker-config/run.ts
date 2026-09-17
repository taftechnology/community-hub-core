import { check } from "./check.js";

const result = check();

if (!result.ok) {
  for (const v of result.violations) {
    console.error(`${v.app}: ${v.message}`);
  }
  process.exit(1);
}

console.log("worker-config: ok");
