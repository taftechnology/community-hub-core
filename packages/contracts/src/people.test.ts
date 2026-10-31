import { describe, expect, it } from "vitest";

import {
  createPersonBody,
  listPeopleBody,
  peopleAccessBody,
  readPersonBody,
  updatePersonBody,
} from "./people.js";

const VALID_UUID = "00000000-0000-4000-8000-000000000001";

describe("people contract schemas (pin 2)", () => {
  it("parses valid list, read, create, and update bodies", () => {
    expect(
      listPeopleBody.safeParse({
        communitySlug: "parish-au",
        kind: "adults",
        search: "John",
        limit: 50,
      }).success,
    ).toBe(true);

    expect(
      listPeopleBody.safeParse({
        communitySlug: "parish-au",
        kind: "minors",
        cursor: "opaque-cursor-token",
      }).success,
    ).toBe(true);

    expect(
      readPersonBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
      }).success,
    ).toBe(true);

    expect(
      createPersonBody.safeParse({
        communitySlug: "parish-au",
        givenName: "Jane",
        familyName: "Doe",
        email: "jane.doe@example.com",
        phone: "+61411111111",
        dateOfBirth: "1990-01-01",
      }).success,
    ).toBe(true);

    expect(
      updatePersonBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        version: 1,
        givenName: "Janet",
        email: null,
      }).success,
    ).toBe(true);
    expect(
      peopleAccessBody.safeParse({
        communitySlug: "parish-au",
      }).success,
    ).toBe(true);
  });

  it("strictly rejects forbidden fields: includeRestricted, isMinor, orgId, communityId (pin 2)", () => {
    for (const schema of [
      listPeopleBody,
      readPersonBody,
      createPersonBody,
      updatePersonBody,
      peopleAccessBody,
    ]) {
      const base =
        schema === listPeopleBody
          ? { communitySlug: "slug" }
          : schema === readPersonBody
            ? { communitySlug: "slug", personId: VALID_UUID }
            : schema === createPersonBody
              ? { communitySlug: "slug", givenName: "A", familyName: "B" }
              : schema === updatePersonBody
                ? { communitySlug: "slug", personId: VALID_UUID, version: 1 }
                : { communitySlug: "slug" };

      expect(schema.safeParse({ ...base, includeRestricted: true }).success).toBe(false);
      expect(schema.safeParse({ ...base, isMinor: false }).success).toBe(false);
      expect(schema.safeParse({ ...base, orgId: VALID_UUID }).success).toBe(false);
      expect(schema.safeParse({ ...base, communityId: VALID_UUID }).success).toBe(false);
      expect(schema.safeParse({ ...base, extra: "forbidden" }).success).toBe(false);
    }
  });

  it("enforces validation constraints on fields", () => {
    // kind must be adults or minors
    expect(listPeopleBody.safeParse({ communitySlug: "slug", kind: "unknown" }).success).toBe(
      false,
    );

    // limit bounds 1 to 100
    expect(listPeopleBody.safeParse({ communitySlug: "slug", limit: 0 }).success).toBe(false);
    expect(listPeopleBody.safeParse({ communitySlug: "slug", limit: 101 }).success).toBe(false);

    // search length cap 100
    expect(
      listPeopleBody.safeParse({ communitySlug: "slug", search: "a".repeat(101) }).success,
    ).toBe(false);

    // cursor length cap 1024
    expect(
      listPeopleBody.safeParse({ communitySlug: "slug", cursor: "c".repeat(1024) }).success,
    ).toBe(true);
    expect(
      listPeopleBody.safeParse({ communitySlug: "slug", cursor: "c".repeat(1025) }).success,
    ).toBe(false);

    // names min 1 max 100
    expect(
      createPersonBody.safeParse({
        communitySlug: "slug",
        givenName: "",
        familyName: "Doe",
      }).success,
    ).toBe(false);
    expect(
      createPersonBody.safeParse({
        communitySlug: "slug",
        givenName: "a".repeat(101),
        familyName: "Doe",
      }).success,
    ).toBe(false);

    // version must be a positive integer
    expect(
      updatePersonBody.safeParse({
        communitySlug: "slug",
        personId: VALID_UUID,
        version: 0,
      }).success,
    ).toBe(false);
    expect(
      updatePersonBody.safeParse({
        communitySlug: "slug",
        personId: VALID_UUID,
        version: -1,
      }).success,
    ).toBe(false);
    expect(
      updatePersonBody.safeParse({
        communitySlug: "slug",
        personId: VALID_UUID,
        version: 1.5,
      }).success,
    ).toBe(false);

    // UUID validation
    expect(
      readPersonBody.safeParse({
        communitySlug: "slug",
        personId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("fits well under the 4096-byte request body cap at maximum field lengths", () => {
    const maxCreateBody = {
      communitySlug: "a".repeat(100),
      givenName: "g".repeat(100),
      familyName: "f".repeat(100),
      email: `${"e".repeat(50)}@${"example".repeat(5)}.com`,
      phone: "+614" + "1".repeat(20),
      dateOfBirth: "1999-12-31",
    };
    expect(createPersonBody.safeParse(maxCreateBody).success).toBe(true);
    const serializedCreate = JSON.stringify(maxCreateBody);
    expect(Buffer.byteLength(serializedCreate, "utf8")).toBeLessThan(4096);

    const maxUpdateBody = {
      communitySlug: "a".repeat(100),
      personId: VALID_UUID,
      version: 999999,
      givenName: "g".repeat(100),
      familyName: "f".repeat(100),
      email: `${"e".repeat(50)}@${"example".repeat(5)}.com`,
      phone: "+614" + "1".repeat(20),
      dateOfBirth: "1999-12-31",
    };
    expect(updatePersonBody.safeParse(maxUpdateBody).success).toBe(true);
    const serializedUpdate = JSON.stringify(maxUpdateBody);
    expect(Buffer.byteLength(serializedUpdate, "utf8")).toBeLessThan(4096);
  });
});
