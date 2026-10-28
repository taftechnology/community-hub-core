import { describe, expect, it } from "vitest";

import usageModule from "../module.manifest.js";

describe("core.usage manifest", () => {
  it("declares the usage module manifest with all data classes", () => {
    expect(usageModule).toEqual({
      key: "core.usage",
      version: 1,
      requires: [],
      publishes: [],
      subscribes: [],
      ports: [],
      features: [],
      permissions: [],
      dataClasses: {
        "usage_facts_daily.org_id": "internal",
        "usage_facts_daily.community_id": "internal",
        "usage_facts_daily.feature_key": "internal",
        "usage_facts_daily.day": "internal",
        "usage_facts_daily.success_count": "internal",
      },
    });
  });
});
