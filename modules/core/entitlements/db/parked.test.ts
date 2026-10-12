import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TFVARS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../infra/regions/au/env/staging.tfvars",
);

describe("staging stays parked", () => {
  it("keeps the database off and runs no tasks", () => {
    const text = readFileSync(TFVARS, "utf8");
    expect(text).toMatch(/enable_database\s*=\s*false/);
    expect(text).toMatch(/desired_count\s*=\s*0/);
    expect(text).not.toContain("service_image");
  });
});
