import { describe, expect, it } from "vitest";

import { ImplicitOrganisationError } from "./error.js";
import { implicitPair } from "./slug.js";

describe("implicitPair", () => {
  it("accepts one DNS label for both slugs", () => {
    expect(
      implicitPair({ organisationSlug: "example-parish", communitySlug: "example-parish" }),
    ).toEqual({
      organisationSlug: "example-parish",
      communitySlug: "example-parish",
      region: "au",
      kind: "implicit",
    });
  });

  it("accepts a 3-character label and a 63-character label", () => {
    expect(implicitPair({ organisationSlug: "abc", communitySlug: "a".repeat(63) })).toMatchObject({
      organisationSlug: "abc",
      communitySlug: "a".repeat(63),
      region: "au",
      kind: "implicit",
    });
  });

  it.each([
    "Example",
    "a_b",
    "-ab",
    "ab-",
    "",
    "ab",
    "a".repeat(64),
    "admin",
    "api",
    "app",
    "assets",
    "au",
    "auth",
    "billing",
    "cdn",
    "docs",
    "help",
    "login",
    "mail",
    "ops",
    "portal",
    "staging",
    "static",
    "status",
    "support",
    "www",
  ])("rejects %j", (slug) => {
    expect(() => implicitPair({ organisationSlug: slug, communitySlug: "example-parish" })).toThrow(
      ImplicitOrganisationError,
    );
    try {
      implicitPair({ organisationSlug: slug, communitySlug: "example-parish" });
    } catch (error) {
      expect(error).toBeInstanceOf(ImplicitOrganisationError);
      expect(error).toBeInstanceOf(Error);
      expect((error as ImplicitOrganisationError).code).toBe("invalid_slug");
    }
  });
});
