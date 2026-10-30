import { describe, expect, it } from "vitest";

import groupsModule from "../module.manifest.js";

describe("groups manifest", () => {
  it("declares the groups module manifest with all data classes (pin 25)", () => {
    expect(groupsModule).toEqual({
      key: "groups",
      version: 1,
      requires: ["core.people", "core.usage"],
      publishes: [],
      subscribes: [],
      ports: [],
      features: ["groups.basic"],
      permissions: ["groups.manage", "groups.export"],
      dataClasses: {
        "groups.org_id": "internal",
        "groups.community_id": "internal",
        "groups.id": "internal",
        "groups.name": "internal",
        "groups.name_key": "internal",
        "groups.description": "internal",
        "groups.kind": "internal",
        "groups.status": "internal",
        "groups.created_at": "internal",
        "groups.updated_at": "internal",
        "group_members.org_id": "internal",
        "group_members.community_id": "internal",
        "group_members.group_id": "internal",
        "group_members.person_id": "internal",
        "group_members.role": "internal",
        "group_members.added_at": "internal",
      },
    });
  });
});
