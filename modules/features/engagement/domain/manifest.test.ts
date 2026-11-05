import { describe, expect, it } from "vitest";

import engagementModule from "../module.manifest.js";

describe("engagement manifest", () => {
  it("declares the engagement module manifest with all data classes (pin 25)", () => {
    expect(engagementModule).toEqual({
      key: "engagement",
      version: 1,
      requires: ["core.usage"],
      publishes: [],
      subscribes: [],
      ports: [],
      features: ["module.engagement"],
      permissions: ["service_times.manage"],
      website: { collections: ["engagement.service_times"] },
      dataClasses: {
        "service_times.org_id": "internal",
        "service_times.community_id": "internal",
        "service_times.content_html": "public",
        "service_times.version": "internal",
        "service_times.created_at": "internal",
        "service_times.updated_at": "internal",
      },
    });
  });

  it("dataClasses covers every column of every table of the module and nothing else", () => {
    const expectedColumns = [
      "service_times.org_id",
      "service_times.community_id",
      "service_times.content_html",
      "service_times.version",
      "service_times.created_at",
      "service_times.updated_at",
    ];
    expect(Object.keys(engagementModule.dataClasses ?? {}).sort()).toEqual(expectedColumns.sort());
  });
});
