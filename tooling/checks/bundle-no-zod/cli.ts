import { check } from "./check.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bundle-no-zod <outdir>");
  process.exit(2);
}

const result = check(dir);
if (!result.ok) {
  for (const violation of result.violations) {
    console.error(`${violation.file}: ${violation.message}`);
  }
  process.exit(1);
}
