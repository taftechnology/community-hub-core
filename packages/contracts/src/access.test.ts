import { describe, expect, it } from "vitest";

import {
  bootstrapOwnerBody,
  createCustomRoleBody,
  deleteCustomRoleBody,
  grantBody,
  linkUserBody,
  listGrantsBody,
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
});
