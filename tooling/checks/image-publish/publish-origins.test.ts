import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workflowPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.github/workflows/ci.yml",
);

function adminPublishJob(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === "  admin-publish:");
  if (start === -1) {
    return "";
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[a-z0-9-]+:$/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("admin publish origins", () => {
  it("exports the directory origins and does not echo them", () => {
    const job = adminPublishJob(fs.readFileSync(workflowPath, "utf8"));
    expect(job).toContain("vars.ADMIN_API_ORIGIN");
    expect(job).toContain("vars.ADMIN_AUTH_ORIGIN");
    expect(job).toContain("export VITE_API_ORIGIN");
    expect(job).toContain("export VITE_AUTH_ORIGIN");
    expect(job).toMatch(/-z "\$\{ADMIN_API_ORIGIN:-}"/);
    expect(job).toMatch(/-z "\$\{ADMIN_AUTH_ORIGIN:-}"/);
    expect(job).toContain("admin publish origins are unset");
    for (const line of job.split("\n")) {
      if (!line.includes("echo")) {
        continue;
      }
      expect(line).not.toContain("ADMIN_API_ORIGIN");
      expect(line).not.toContain("ADMIN_AUTH_ORIGIN");
      expect(line).not.toContain("VITE_API_ORIGIN");
      expect(line).not.toContain("VITE_AUTH_ORIGIN");
    }
  });
});
