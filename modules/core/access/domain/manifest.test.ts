import { describe, expect, it } from "vitest";

import accessModule from "../module.manifest.js";

describe("core.access manifest", () => {
  it("declares the access module and every grant column", () => {
    expect(accessModule).toEqual({
      key: "core.access",
      version: 1,
      requires: ["core.people"],
      publishes: [],
      subscribes: [],
      ports: [],
      permissions: [
        "access.users.view",
        "access.users.manage",
        "access.roles.view",
        "access.roles.manage",
      ],
      dataClasses: {
        "organisation_role_grants.id": "internal",
        "organisation_role_grants.org_id": "internal",
        "organisation_role_grants.user_id": "internal",
        "organisation_role_grants.role_key": "internal",
        "community_role_grants.id": "internal",
        "community_role_grants.org_id": "internal",
        "community_role_grants.community_id": "internal",
        "community_role_grants.user_id": "internal",
        "community_role_grants.role_key": "internal",
        "community_role_grants.custom_role_id": "internal",
        "custom_roles.id": "internal",
        "custom_roles.org_id": "internal",
        "custom_roles.community_id": "internal",
        "custom_roles.key": "internal",
        "custom_role_permissions.org_id": "internal",
        "custom_role_permissions.community_id": "internal",
        "custom_role_permissions.custom_role_id": "internal",
        "custom_role_permissions.permission": "internal",
        "user_links.id": "internal",
        "user_links.org_id": "internal",
        "user_links.community_id": "internal",
        "user_links.user_id": "internal",
        "user_links.person_id": "internal",
      },
    });
    expect(accessModule).not.toHaveProperty("website");
    expect(accessModule).not.toHaveProperty("entitlement");
  });
});
