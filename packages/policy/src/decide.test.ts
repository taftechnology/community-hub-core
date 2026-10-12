import { describe, expect, it } from "vitest";

import { bundle, catalogue, decide, type DecideInput } from "./decide.js";

const viewPermissions = ["access.users.view", "access.roles.view"] as const;

function actor(
  permission: string,
  roles: Pick<DecideInput, "organisationRoleKeys" | "communityRoleKeys">,
  flags: Pick<DecideInput, "guardianView" | "personScoped"> = {
    guardianView: false,
    personScoped: false,
  },
): DecideInput {
  return {
    permission,
    organisationRoleKeys: roles.organisationRoleKeys,
    communityRoleKeys: roles.communityRoleKeys,
    customPermissions: [],
    guardianView: flags.guardianView,
    personScoped: flags.personScoped,
  };
}

describe("catalogue", () => {
  it("lists the five permissions in order", () => {
    expect(catalogue()).toEqual([
      "access.users.view",
      "access.users.manage",
      "access.roles.view",
      "access.roles.manage",
      "people.restricted.read",
    ]);
  });
});

describe("bundle", () => {
  it("returns null for a platform role", () => {
    expect(bundle("platform_admin")).toBeNull();
  });

  it("returns an empty list for finance", () => {
    expect(bundle("finance")).toEqual([]);
  });

  it("returns the spec bundles for the other built-in roles", () => {
    const all = catalogue();
    expect(bundle("org_admin")).toEqual(all);
    expect(bundle("community_admin")).toEqual(all);
    expect(bundle("org_billing")).toEqual(["access.users.view"]);
    expect(bundle("org_auditor")).toEqual(["access.users.view", "access.roles.view"]);
    expect(bundle("safeguarding_officer")).toEqual(["people.restricted.read", "access.users.view"]);
    expect(bundle("volunteer_coordinator")).toEqual(["access.users.view"]);
    expect(bundle("content_editor")).toEqual([]);
    expect(bundle("member")).toEqual([]);
  });
});

describe("decide", () => {
  it("allows an organisation owner every catalogue permission", () => {
    for (const permission of catalogue()) {
      expect(
        decide(
          actor(permission, {
            organisationRoleKeys: ["org_owner"],
            communityRoleKeys: [],
          }),
        ),
      ).toBe(true);
    }
  });

  it("allows staff only the two view permissions", () => {
    for (const permission of catalogue()) {
      expect(
        decide(
          actor(permission, {
            organisationRoleKeys: [],
            communityRoleKeys: ["staff"],
          }),
        ),
      ).toBe(viewPermissions.includes(permission as (typeof viewPermissions)[number]));
    }
  });

  it("denies a member every catalogue permission", () => {
    for (const permission of catalogue()) {
      expect(
        decide(
          actor(permission, {
            organisationRoleKeys: [],
            communityRoleKeys: ["member"],
          }),
        ),
      ).toBe(false);
    }
  });

  it("allows a person-scoped guardian the restricted read and not role management", () => {
    const flags = { guardianView: true, personScoped: true };
    const roles = { organisationRoleKeys: [], communityRoleKeys: [] };
    expect(decide(actor("people.restricted.read", roles, flags))).toBe(true);
    expect(decide(actor("access.roles.manage", roles, flags))).toBe(false);
  });

  it("denies a guardian the restricted read when the call is not person-scoped", () => {
    expect(
      decide(
        actor(
          "people.restricted.read",
          { organisationRoleKeys: [], communityRoleKeys: [] },
          { guardianView: true, personScoped: false },
        ),
      ),
    ).toBe(false);
  });
});
