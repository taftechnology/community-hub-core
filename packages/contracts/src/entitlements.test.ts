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

  it("rejects a malformed entitlement key", () => {
    expect(
      toggleEntitlementBody.safeParse({
        communitySlug: "ada",
        key: "not-a-key",
        enabled: false,
      }).success,
    ).toBe(false);
    expect(
      toggleEntitlementBody.safeParse({
        communitySlug: "ada",
        key: "people.directory",
        enabled: false,
      }).success,
    ).toBe(true);
  });
});
