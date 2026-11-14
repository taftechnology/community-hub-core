import { describe, expect, it } from "vitest";

import {
  acceptInvitationBody,
  acceptInvitationResponse,
  accessErrorBody,
  bootstrapOwnerBody,
  CAPABILITIES_ALLOW_LIST,
  capabilitiesBody,
  capabilitiesResponse,
  createCustomRoleBody,
  createInvitationBody,
  createInvitationResponse,
  deleteCustomRoleBody,
  grantBody,
  invitationActionBody,
  linkUserBody,
  listGrantsBody,
  listInvitationsBody,
  listInvitationsResponse,
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
      expect(listUsersBody.safeParse({ communitySlug: "parish" }).success).toBe(true);
    });

    it("rejects missing or invalid communitySlug", () => {
      expect(listUsersBody.safeParse({}).success).toBe(false);
      expect(listUsersBody.safeParse({ communitySlug: "" }).success).toBe(false);
      expect(listUsersBody.safeParse({ communitySlug: 123 }).success).toBe(false);
    });

    it("rejects extra keys such as userIds", () => {
      expect(listUsersBody.safeParse({ communitySlug: "parish", userIds: [USER] }).success).toBe(
        false,
      );
      expect(listUsersBody.safeParse({ communitySlug: "parish", extra: "forbidden" }).success).toBe(
        false,
      );
    });
  });

  describe("listUsersResponse", () => {
    const fullUser = {
      userId: USER,
      personId: PERSON,
      name: { given: "Morgan", family: "Finch" },
      email: "morgan@example.com",
      phone: "+61491570006",
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
        email: "morgan@example.com",
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
        name: { given: "Morgan", family: "Finch" },
        email: null,
        phone: "+61491570006",
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
        name: { given: "Morgan", family: "Finch" },
        email: "morgan@example.com",
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

    it("rejects a missing key at either level", () => {
      const keys: (keyof typeof fullUser)[] = [
        "userId",
        "personId",
        "name",
        "email",
        "phone",
        "minor",
      ];
      for (const key of keys) {
        const { [key]: _, ...rest } = fullUser;
        void _;
        expect(
          listUsersResponse.safeParse({
            phoneVisible: true,
            users: [rest],
          }).success,
        ).toBe(false);
      }

      expect(
        listUsersResponse.safeParse({
          users: [fullUser],
        }).success,
      ).toBe(false);

      expect(
        listUsersResponse.safeParse({
          phoneVisible: true,
        }).success,
      ).toBe(false);
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
                given: "Morgan",
                family: "Finch",
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

      // null userId
      expect(
        listUsersResponse.safeParse({
          phoneVisible: true,
          users: [{ ...fullUser, userId: null }],
        }).success,
      ).toBe(false);

      // null minor
      expect(
        listUsersResponse.safeParse({
          phoneVisible: true,
          users: [{ ...fullUser, minor: null }],
        }).success,
      ).toBe(false);
    });
  });

  describe("invitation schemas (Task 1)", () => {
    describe("createInvitationBody", () => {
      it("accepts valid inputs with roleKey only, customRoleId only, or personId only", () => {
        expect(
          createInvitationBody.safeParse({
            communitySlug: "ada",
            email: "alex@example.test",
            roleKey: "community_admin",
          }).success,
        ).toBe(true);

        expect(
          createInvitationBody.safeParse({
            communitySlug: "ada",
            email: "alex@example.test",
            customRoleId: CUSTOM,
          }).success,
        ).toBe(true);

        expect(
          createInvitationBody.safeParse({
            communitySlug: "ada",
            email: "alex@example.test",
            personId: PERSON,
          }).success,
        ).toBe(true);
      });

      it("accepts valid inputs with both role and personId", () => {
        expect(
          createInvitationBody.safeParse({
            communitySlug: "ada",
            email: "alex@example.test",
            roleKey: "community_admin",
            personId: PERSON,
          }).success,
        ).toBe(true);

        expect(
          createInvitationBody.safeParse({
            communitySlug: "ada",
            email: "alex@example.test",
            customRoleId: CUSTOM,
            personId: PERSON,
          }).success,
        ).toBe(true);
      });

      it("rejects neither role nor contact", () => {
        expect(
          createInvitationBody.safeParse({
            communitySlug: "ada",
            email: "alex@example.test",
          }).success,
        ).toBe(false);
      });

      it("rejects both roleKey and customRoleId", () => {
        expect(
          createInvitationBody.safeParse({
            communitySlug: "ada",
            email: "alex@example.test",
            roleKey: "community_admin",
            customRoleId: CUSTOM,
          }).success,
        ).toBe(false);

        expect(
          createInvitationBody.safeParse({
            communitySlug: "ada",
            email: "alex@example.test",
            roleKey: "community_admin",
            customRoleId: CUSTOM,
            personId: PERSON,
          }).success,
        ).toBe(false);
      });

      it("enforces email validation and length limits", () => {
        // "alex@" rejected
        expect(
          createInvitationBody.safeParse({
            communitySlug: "ada",
            email: "alex@",
            roleKey: "community_admin",
          }).success,
        ).toBe(false);

        // 254-char email accepted
        const valid254 = `${"a".repeat(241)}@example.test`;
        expect(valid254.length).toBe(254);
        expect(
          createInvitationBody.safeParse({
            communitySlug: "ada",
            email: valid254,
            roleKey: "community_admin",
          }).success,
        ).toBe(true);

        // 255-char email rejected
        const invalid255 = `${"a".repeat(242)}@example.test`;
        expect(invalid255.length).toBe(255);
        expect(
          createInvitationBody.safeParse({
            communitySlug: "ada",
            email: invalid255,
            roleKey: "community_admin",
          }).success,
        ).toBe(false);
      });

      it("strictly rejects extra keys", () => {
        expect(
          createInvitationBody.safeParse({
            communitySlug: "ada",
            email: "alex@example.test",
            roleKey: "community_admin",
            extra: "forbidden",
          }).success,
        ).toBe(false);
      });
    });

    describe("createInvitationResponse", () => {
      it("parses valid response", () => {
        expect(
          createInvitationResponse.safeParse({
            invitationId: GRANT,
          }).success,
        ).toBe(true);
      });

      it("strictly rejects extra keys", () => {
        expect(
          createInvitationResponse.safeParse({
            invitationId: GRANT,
            extra: "forbidden",
          }).success,
        ).toBe(false);
      });

      it("rejects invalid invitationId", () => {
        expect(
          createInvitationResponse.safeParse({
            invitationId: "not-a-uuid",
          }).success,
        ).toBe(false);
      });
    });

    describe("listInvitationsBody", () => {
      it("parses valid body", () => {
        expect(listInvitationsBody.safeParse({ communitySlug: "ada" }).success).toBe(true);
      });

      it("strictly rejects extra keys", () => {
        expect(
          listInvitationsBody.safeParse({ communitySlug: "ada", extra: "forbidden" }).success,
        ).toBe(false);
      });

      it("rejects invalid communitySlug", () => {
        expect(listInvitationsBody.safeParse({}).success).toBe(false);
        expect(listInvitationsBody.safeParse({ communitySlug: "" }).success).toBe(false);
      });
    });

    describe("listInvitationsResponse", () => {
      const validItem = {
        id: "00000000-0000-4000-8000-000000000010",
        email: "alex@example.test",
        roleKey: "community_admin",
        customRoleId: null,
        linksContact: true,
        expiresAt: "2026-11-21T00:00:00.000Z",
      };

      it("parses valid response with items", () => {
        expect(
          listInvitationsResponse.safeParse({
            invitations: [
              validItem,
              {
                id: "00000000-0000-4000-8000-000000000011",
                email: "sam@example.test",
                roleKey: null,
                customRoleId: CUSTOM,
                linksContact: false,
                expiresAt: "2026-11-21T00:00:00.000Z",
              },
            ],
          }).success,
        ).toBe(true);
      });

      it("parses empty invitations array", () => {
        expect(listInvitationsResponse.safeParse({ invitations: [] }).success).toBe(true);
      });

      it("strictly rejects extra keys at top level and item level", () => {
        expect(
          listInvitationsResponse.safeParse({
            invitations: [validItem],
            extra: "forbidden",
          }).success,
        ).toBe(false);

        expect(
          listInvitationsResponse.safeParse({
            invitations: [{ ...validItem, extra: "forbidden" }],
          }).success,
        ).toBe(false);
      });

      it("rejects missing or invalid fields in item", () => {
        expect(
          listInvitationsResponse.safeParse({
            invitations: [{ ...validItem, linksContact: "true" }],
          }).success,
        ).toBe(false);

        expect(
          listInvitationsResponse.safeParse({
            invitations: [{ ...validItem, id: "not-a-uuid" }],
          }).success,
        ).toBe(false);

        const { linksContact: _, ...withoutLinksContact } = validItem;
        void _;
        expect(
          listInvitationsResponse.safeParse({
            invitations: [withoutLinksContact],
          }).success,
        ).toBe(false);
      });
    });

    describe("invitationActionBody", () => {
      it("parses valid body", () => {
        expect(
          invitationActionBody.safeParse({
            communitySlug: "ada",
            invitationId: GRANT,
          }).success,
        ).toBe(true);
      });

      it("strictly rejects extra keys", () => {
        expect(
          invitationActionBody.safeParse({
            communitySlug: "ada",
            invitationId: GRANT,
            extra: "forbidden",
          }).success,
        ).toBe(false);
      });

      it("rejects invalid invitationId or missing fields", () => {
        expect(
          invitationActionBody.safeParse({
            communitySlug: "ada",
            invitationId: "not-a-uuid",
          }).success,
        ).toBe(false);

        expect(invitationActionBody.safeParse({ communitySlug: "ada" }).success).toBe(false);
      });
    });

    describe("acceptInvitationBody", () => {
      it("parses valid token of at most 120 characters", () => {
        expect(acceptInvitationBody.safeParse({ token: "v1.valid-token" }).success).toBe(true);
        expect(acceptInvitationBody.safeParse({ token: "a".repeat(120) }).success).toBe(true);
      });

      it("rejects token exceeding 120 characters", () => {
        expect(acceptInvitationBody.safeParse({ token: "a".repeat(121) }).success).toBe(false);
      });

      it("strictly rejects extra keys", () => {
        expect(
          acceptInvitationBody.safeParse({
            token: "v1.valid-token",
            extra: "forbidden",
          }).success,
        ).toBe(false);
      });

      it("rejects invalid types or missing token", () => {
        expect(acceptInvitationBody.safeParse({}).success).toBe(false);
        expect(acceptInvitationBody.safeParse({ token: 12345 }).success).toBe(false);
      });
    });

    describe("acceptInvitationResponse", () => {
      it("parses valid response", () => {
        expect(acceptInvitationResponse.safeParse({ communitySlug: "ada" }).success).toBe(true);
      });

      it("strictly rejects extra keys", () => {
        expect(
          acceptInvitationResponse.safeParse({
            communitySlug: "ada",
            extra: "forbidden",
          }).success,
        ).toBe(false);
      });

      it("rejects empty or missing communitySlug", () => {
        expect(acceptInvitationResponse.safeParse({}).success).toBe(false);
        expect(acceptInvitationResponse.safeParse({ communitySlug: "" }).success).toBe(false);
      });
    });

    describe("accessErrorBody", () => {
      const allowedCodes = [
        "user_not_member",
        "wrong_address",
        "role_not_found",
        "person_not_found",
        "invitation_invalid",
        "invitation_not_found",
        "already_invited",
        "too_many",
        "person_linked",
        "invitation_void",
        "person_minor",
      ] as const;

      it("parses each of the 11 error codes", () => {
        for (const code of allowedCodes) {
          expect(accessErrorBody.safeParse({ error: code }).success).toBe(true);
        }
      });

      it("strictly rejects extra keys", () => {
        expect(
          accessErrorBody.safeParse({
            error: "user_not_member",
            extra: "forbidden",
          }).success,
        ).toBe(false);
      });

      it("rejects unknown error codes", () => {
        expect(accessErrorBody.safeParse({ error: "not_found" }).success).toBe(false);
        expect(accessErrorBody.safeParse({ error: "unknown_error" }).success).toBe(false);
        expect(accessErrorBody.safeParse({}).success).toBe(false);
      });
    });
  });
});
