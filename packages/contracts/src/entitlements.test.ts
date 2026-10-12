import { describe, expect, it } from "vitest";

import { listEntitlementsBody, toggleEntitlementBody } from "./entitlements.js";

describe("entitlement bodies", () => {
  it("rejects an organisation id on the list body", () => {
    expect(
      listEntitlementsBody.safeParse({ communitySlug: "ada", organisationId: "org" }).success,
    ).toBe(false);
  });

  it("rejects a toggle body that omits enabled", () => {
    expect(
      toggleEntitlementBody.safeParse({ communitySlug: "ada", key: "people.directory" }).success,
    ).toBe(false);
  });
});
