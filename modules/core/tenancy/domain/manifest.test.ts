import { describe, expect, it } from "vitest";

import tenancyModule from "../module.manifest.js";

describe("core.tenancy manifest", () => {
  it("declares the eight internal columns and nothing else", () => {
    expect(tenancyModule).toEqual({
      key: "core.tenancy",
      version: 1,
      requires: [],
      publishes: [],
      subscribes: [],
      ports: [],
      dataClasses: {
        "organisations.id": "internal",
        "organisations.slug": "internal",
        "organisations.region": "internal",
        "organisations.kind": "internal",
        "communities.id": "internal",
        "communities.organisation_id": "internal",
        "communities.slug": "internal",
        "communities.region": "internal",
      },
    });
  });
});
