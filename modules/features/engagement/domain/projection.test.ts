import { describe, expect, it } from "vitest";

import manifest from "../module.manifest.js";
import { PUBLIC_SERVICE_TIMES_COLUMNS, toPublicServiceTimes } from "./projection.js";

describe("projection allow-list", () => {
  it("derives allow-list from manifest dataClasses and permits only public columns", () => {
    const publicColumnsFromManifest = Object.entries(manifest.dataClasses ?? {})
      .filter(
        ([key, classification]) => key.startsWith("service_times.") && classification === "public",
      )
      .map(([key]) => key.replace("service_times.", ""));

    expect(publicColumnsFromManifest).toEqual(["content_html"]);
    expect([...PUBLIC_SERVICE_TIMES_COLUMNS]).toEqual(publicColumnsFromManifest);

    for (const column of PUBLIC_SERVICE_TIMES_COLUMNS) {
      const manifestClass = (manifest.dataClasses as Record<string, string>)[
        `service_times.${column}`
      ];
      expect(manifestClass, `Column ${column} must be classified as public in manifest`).toBe(
        "public",
      );
    }
  });

  it("fails if any non-public column is added to the projection allow-list", () => {
    for (const [key, classification] of Object.entries(manifest.dataClasses ?? {})) {
      if (classification !== "public") {
        const columnName = key.replace("service_times.", "");
        expect(
          PUBLIC_SERVICE_TIMES_COLUMNS.includes(columnName as never),
          `Non-public column ${columnName} (class: ${classification}) must not be in allow-list`,
        ).toBe(false);
      }
    }
  });

  it("toPublicServiceTimes leaks no extra properties and returns exactly { html } (pin 20)", () => {
    const row = {
      content_html: "<p>Sunday Mass at 10am</p>",
      org_id: "00000000-0000-0000-0000-000000000001",
      community_id: "00000000-0000-0000-0000-000000000002",
      version: 4,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-02T00:00:00.000Z"),
      confidential_notes: "Super secret",
      is_minor: true,
    };

    const projected = toPublicServiceTimes(row);
    expect(projected).toEqual({ html: "<p>Sunday Mass at 10am</p>" });
    expect(Object.keys(projected)).toEqual(["html"]);
  });
});
