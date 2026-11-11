import { describe, expect, it } from "vitest";

import {
  bootstrapOwnerBody,
  CAPABILITIES_ALLOW_LIST,
  capabilitiesBody,
  capabilitiesResponse,
  createCustomRoleBody,
  deleteCustomRoleBody,
  grantBody,
  linkUserBody,
  listGrantsBody,
  listUsersBody,
  listUsersResponse,
  revokeGrantBody,
  unlinkUserBody,
} from "./access.js";

const USER = "00000000-0000-4000-8000-000000000002";
const PERSON = "00000000-0000-4000-8000-000000000003";
const GRANT = "00000000-0000-4000-8000-000000000004";
const CUSTOM = "00000000-0000-4000-8000-000000000005";
const ORGANISATION = "00000000-0000-4000-8000-000000000001";

describe("access bodies", () => {
  it("parses each success body", () => {
    expect(listGrantsBody.safeParse({ communitySlug: "ada" }).success).toBe(true);
    expect(bootstrapOwnerBody.safeParse({ communitySlug: "ada" }).success).toBe(true);
    expect(
      grantBody.safeParse({ communitySlug: "ada", userId: USER, roleKey: "staff" }).success,
    ).toBe(true);
    expect(
      grantBody.safeParse({ communitySlug: "ada", userId: USER, customRoleId: CUSTOM }).success,
    ).toBe(true);
    expect(
      revokeGrantBody.safeParse({
        communitySlug: "ada",
        grantId: GRANT,
        scope: "organisation",
      }).success,
    ).toBe(true);
    expect(
      createCustomRoleBody.safeParse({
        communitySlug: "ada",
        key: "choir_lead",
        permissions: ["access.users.view"],
      }).success,
    ).toBe(true);
    expect(
      deleteCustomRoleBody.safeParse({ communitySlug: "ada", customRoleId: CUSTOM }).success,
    ).toBe(true);
    expect(
      linkUserBody.safeParse({ communitySlug: "ada", userId: USER, personId: PERSON }).success,
    ).toBe(true);
    expect(unlinkUserBody.safeParse({ communitySlug: "ada", userId: USER }).success).toBe(true);
  });

  it("rejects an organisation id and a grant that sets both role fields", () => {
    expect(
      listGrantsBody.safeParse({ communitySlug: "ada", organisationId: ORGANISATION }).success,
    ).toBe(false);
    expect(
      grantBody.safeParse({
        communitySlug: "ada",
        userId: USER,
        roleKey: "staff",
        customRoleId: CUSTOM,
      }).success,
    ).toBe(false);
    expect(
      grantBody.safeParse({
        communitySlug: "ada",
        userId: USER,
        roleKey: "staff",
        organisationId: ORGANISATION,
      }).success,
    ).toBe(false);
  });

  describe("capabilities schemas (pin 17)", () => {
    it("parses valid capabilities request body with communitySlug only", () => {
      expect(capabilitiesBody.safeParse({ communitySlug: "ada" }).success).toBe(true);
    });

    it("strictly rejects extra keys or non-slug fields in capabilities request", () => {
      expect(capabilitiesBody.safeParse({ communitySlug: "ada", extra: "forbidden" }).success).toBe(
        false,
      );
      expect(
        capabilitiesBody.safeParse({ communitySlug: "ada", permissions: ["people.view"] }).success,
      ).toBe(false);
      expect(
        capabilitiesBody.safeParse({ communitySlug: "ada", orgId: ORGANISATION }).success,
      ).toBe(false);
    });

    it("matches the allow-list exactly and rejects unknown keys in response", () => {
      const validResponse = {
        permissions: {
          "people.view": true,
          "people.manage": false,
          "people.restricted.read": true,
          "service_times.manage": true,
        },
        entitlements: {
          "people.directory": true,
          "people.households": false,
          "module.engagement": true,
        },
      };

      const parsed = capabilitiesResponse.safeParse(validResponse);
      expect(parsed.success).toBe(true);

      // Verify constant allow-list contents
      expect(new Set(CAPABILITIES_ALLOW_LIST.permissions)).toEqual(
        new Set(["people.view", "people.manage", "people.restricted.read", "service_times.manage"]),
      );
      expect(new Set(CAPABILITIES_ALLOW_LIST.entitlements)).toEqual(
        new Set(["people.directory", "people.households", "module.engagement"]),
      );
      expect([...CAPABILITIES_ALLOW_LIST.permissions]).toEqual([
        "people.view",
        "people.manage",
        "people.restricted.read",
        "service_times.manage",
      ]);
      expect([...CAPABILITIES_ALLOW_LIST.entitlements]).toEqual([
        "people.directory",
        "people.households",
        "module.engagement",
      ]);

      // Verify schema shape matches allow-list
      expect(Object.keys(capabilitiesResponse.shape.permissions.shape).sort()).toEqual(
        [...CAPABILITIES_ALLOW_LIST.permissions].sort(),
      );
      expect(Object.keys(capabilitiesResponse.shape.entitlements.shape).sort()).toEqual(
        [...CAPABILITIES_ALLOW_LIST.entitlements].sort(),
      );

      // Unknown permission key rejected
      expect(
        capabilitiesResponse.safeParse({
          ...validResponse,
          permissions: {
            ...validResponse.permissions,
            "people.unknown": true,
          },
        }).success,
      ).toBe(false);

      // Unknown entitlement key rejected
      expect(
        capabilitiesResponse.safeParse({
          ...validResponse,
          entitlements: {
            ...validResponse.entitlements,
            "people.billing": true,
          },
        }).success,
      ).toBe(false);

      // Missing permission key rejected
      const missingPerm = { ...validResponse.permissions };
      delete (missingPerm as Record<string, boolean>)["people.view"];
      expect(
        capabilitiesResponse.safeParse({
          ...validResponse,
          permissions: missingPerm,
        }).success,
      ).toBe(false);

      const missingServiceTimesPerm = { ...validResponse.permissions };
      delete (missingServiceTimesPerm as Record<string, boolean>)["service_times.manage"];
      expect(
        capabilitiesResponse.safeParse({
          ...validResponse,
          permissions: missingServiceTimesPerm,
        }).success,
      ).toBe(false);

      // Missing entitlement key rejected
      const missingEnt = { ...validResponse.entitlements };
      delete (missingEnt as Record<string, boolean>)["people.directory"];
      expect(
        capabilitiesResponse.safeParse({
          ...validResponse,
          entitlements: missingEnt,
        }).success,
      ).toBe(false);

      const missingEngagementEnt = { ...validResponse.entitlements };
      delete (missingEngagementEnt as Record<string, boolean>)["module.engagement"];
      expect(
        capabilitiesResponse.safeParse({
          ...validResponse,
          entitlements: missingEngagementEnt,
        }).success,
      ).toBe(false);

      // Outer .strict() rejects top-level unknown keys (finding 3)
      expect(
        capabilitiesResponse.safeParse({
          ...validResponse,
          extra: "forbidden",
        }).success,
      ).toBe(false);
      expect(
        capabilitiesResponse.safeParse({
          ...validResponse,
          orgId: ORGANISATION,
        }).success,
      ).toBe(false);
    });
  });

  describe("listUsersBody (pin 4)", () => {
    it("parses valid body with communitySlug only", () => {
      expect(listUsersBody.safeParse({ communitySlug: "ada" }).success).toBe(true);
    });

    it("rejects missing or invalid communitySlug", () => {
      expect(listUsersBody.safeParse({}).success).toBe(false);
      expect(listUsersBody.safeParse({ communitySlug: "" }).success).toBe(false);
      expect(listUsersBody.safeParse({ communitySlug: 123 }).success).toBe(false);
    });

    it("rejects extra keys such as userIds", () => {
      expect(listUsersBody.safeParse({ communitySlug: "ada", userIds: [USER] }).success).toBe(
        false,
      );
      expect(listUsersBody.safeParse({ communitySlug: "ada", extra: "forbidden" }).success).toBe(
        false,
      );
    });
  });

  describe("listUsersResponse", () => {
    const fullUser = {
      userId: USER,
      personId: PERSON,
      name: { given: "Ada", family: "Lovelace" },
      email: "ada@example.com",
      phone: "+61411111111",
      minor: false,
    };

    it("parses valid full response", () => {
      const res = {
        phoneVisible: true,
        users: [fullUser],
      };
      expect(listUsersResponse.safeParse(res).success).toBe(true);
    });

    it("parses each null case in the spec's table", () => {
      // 1. User with no link (unlinked user): personId null, name null, phone null, minor false
      const unlinkedUser = {
        userId: USER,
        personId: null,
        name: null,
        email: "ada@example.com",
        phone: null,
        minor: false,
      };
      expect(
        listUsersResponse.safeParse({
          phoneVisible: true,
          users: [unlinkedUser],
        }).success,
      ).toBe(true);

      // 2. User id with no sign-in account: email null
      const noAccountUser = {
        userId: USER,
        personId: PERSON,
        name: { given: "Ada", family: "Lovelace" },
        email: null,
        phone: "+61411111111",
        minor: false,
      };
      expect(
        listUsersResponse.safeParse({
          phoneVisible: true,
          users: [noAccountUser],
        }).success,
      ).toBe(true);

      // 3. Minor-linked user: name null, email null, phone null, minor true
      const minorUser = {
        userId: USER,
        personId: PERSON,
        name: null,
        email: null,
        phone: null,
        minor: true,
      };
      expect(
        listUsersResponse.safeParse({
          phoneVisible: true,
          users: [minorUser],
        }).success,
      ).toBe(true);

      // 4. Caller lacks people.view or person has no phone: phone null, phoneVisible false
      const noPhoneUser = {
        userId: USER,
        personId: PERSON,
        name: { given: "Ada", family: "Lovelace" },
        email: "ada@example.com",
        phone: null,
        minor: false,
      };
      expect(
        listUsersResponse.safeParse({
          phoneVisible: false,
          users: [noPhoneUser],
        }).success,
      ).toBe(true);

      // 5. Empty user list
      expect(
        listUsersResponse.safeParse({
          phoneVisible: false,
          users: [],
        }).success,
      ).toBe(true);
    });

    it("rejects an extra key at both levels", () => {
      // Top-level extra key
      expect(
        listUsersResponse.safeParse({
          phoneVisible: true,
          users: [fullUser],
          extra: "forbidden",
        }).success,
      ).toBe(false);

      // User-level extra key
      expect(
        listUsersResponse.safeParse({
          phoneVisible: true,
          users: [
            {
              ...fullUser,
              extra: "forbidden",
            },
          ],
        }).success,
      ).toBe(false);

      // Name-level extra key
      expect(
        listUsersResponse.safeParse({
          phoneVisible: true,
          users: [
            {
              ...fullUser,
              name: {
                given: "Ada",
                family: "Lovelace",
                extra: "forbidden",
              },
            },
          ],
        }).success,
      ).toBe(false);
    });

    it("rejects invalid types", () => {
      // invalid userId
      expect(
        listUsersResponse.safeParse({
          phoneVisible: true,
          users: [{ ...fullUser, userId: "not-a-uuid" }],
        }).success,
      ).toBe(false);

      // invalid personId
      expect(
        listUsersResponse.safeParse({
          phoneVisible: true,
          users: [{ ...fullUser, personId: "not-a-uuid" }],
        }).success,
      ).toBe(false);

      // invalid minor (not boolean)
      expect(
        listUsersResponse.safeParse({
          phoneVisible: true,
          users: [{ ...fullUser, minor: "false" }],
        }).success,
      ).toBe(false);

      // invalid phoneVisible (not boolean)
      expect(
        listUsersResponse.safeParse({
          phoneVisible: "true",
          users: [fullUser],
        }).success,
      ).toBe(false);
    });
  });
});
