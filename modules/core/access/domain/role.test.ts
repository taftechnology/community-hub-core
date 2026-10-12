import { describe, expect, it } from "vitest";

import { AccessError } from "./error.js";
import { assertCustomRoleCapacity, parseCustomRoleKey, parsePermissionList } from "./role.js";

describe("custom role keys", () => {
  it("accepts a lower-case key", () => {
    expect(parseCustomRoleKey("choir_lead")).toBe("choir_lead");
  });

  it("rejects a built-in key, a platform key, and a key outside the pattern", () => {
    for (const key of ["Org_Owner", "org_owner", "platform_admin", "A", "has space"]) {
      expect(() => parseCustomRoleKey(key), key).toThrow(AccessError);
      try {
        parseCustomRoleKey(key);
      } catch (error) {
        expect(error, key).toBeInstanceOf(AccessError);
        expect(error, key).toMatchObject({ code: "invalid_role" });
      }
    }
  });
});

describe("permission lists", () => {
  it("returns a catalogue subset", () => {
    expect(parsePermissionList(["access.users.view", "people.restricted.read"])).toEqual([
      "access.users.view",
      "people.restricted.read",
    ]);
  });

  it("rejects an empty list, a duplicate, and a string outside the catalogue", () => {
    for (const permissions of [[], ["access.users.view", "access.users.view"], ["giving.refund"]]) {
      expect(() => parsePermissionList(permissions)).toThrow(AccessError);
      try {
        parsePermissionList(permissions);
      } catch (error) {
        expect(error).toBeInstanceOf(AccessError);
        expect(error).toMatchObject({ code: "invalid_permission" });
      }
    }
  });
});

describe("custom role capacity", () => {
  it("allows nineteen and refuses twenty", () => {
    expect(assertCustomRoleCapacity(19)).toBeUndefined();
    expect(() => assertCustomRoleCapacity(20)).toThrow(AccessError);
    try {
      assertCustomRoleCapacity(20);
    } catch (error) {
      expect(error).toBeInstanceOf(AccessError);
      expect(error).toMatchObject({ code: "limit_reached" });
    }
  });
});
