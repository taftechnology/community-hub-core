import { describe, expect, it } from "vitest";

import { BUILT_IN_ROLE_KEYS, roleLabel } from "./role-labels";

describe("roleLabel", () => {
  it("gives every BUILT_IN key a non-empty label", () => {
    const expectedKeys = [
      "org_owner",
      "org_admin",
      "org_billing",
      "org_auditor",
      "community_admin",
      "staff",
      "finance",
      "safeguarding_officer",
      "volunteer_coordinator",
      "content_editor",
      "member",
    ];

    expect(BUILT_IN_ROLE_KEYS).toEqual(expectedKeys);

    for (const key of BUILT_IN_ROLE_KEYS) {
      const label = roleLabel(key);
      expect(typeof label).toBe("string");
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).not.toBe(key);
    }
  });

  it("returns the key unchanged for an unknown or custom role key", () => {
    expect(roleLabel("custom_role_key")).toBe("custom_role_key");
    expect(roleLabel("pastoral_worker")).toBe("pastoral_worker");
    expect(roleLabel("")).toBe("");
  });

  it("maps specific built-in roles to expected display labels", () => {
    expect(roleLabel("community_admin")).toBe("Community Admin");
    expect(roleLabel("org_owner")).toBe("Organisation Owner");
    expect(roleLabel("org_admin")).toBe("Organisation Admin");
    expect(roleLabel("org_billing")).toBe("Organisation Billing");
    expect(roleLabel("org_auditor")).toBe("Organisation Auditor");
    expect(roleLabel("staff")).toBe("Staff");
    expect(roleLabel("finance")).toBe("Finance");
    expect(roleLabel("safeguarding_officer")).toBe("Safeguarding Officer");
    expect(roleLabel("volunteer_coordinator")).toBe("Volunteer Coordinator");
    expect(roleLabel("content_editor")).toBe("Content Editor");
    expect(roleLabel("member")).toBe("Member");
  });
});
