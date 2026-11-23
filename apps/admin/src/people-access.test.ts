import { describe, expect, it } from "vitest";

import { defaultAccess, parseAccess } from "./people-access";

describe("people-access", () => {
  it("defaultAccess has service_times.manage and module.engagement as false", () => {
    expect(defaultAccess.permissions["service_times.manage"]).toBe(false);
    expect(defaultAccess.entitlements["module.engagement"]).toBe(false);
  });

  it("parseAccess parses true booleans for service_times.manage and module.engagement", () => {
    const raw = {
      permissions: {
        "service_times.manage": true,
      },
      entitlements: {
        "module.engagement": true,
      },
    };
    const parsed = parseAccess(raw);
    expect(parsed.permissions["service_times.manage"]).toBe(true);
    expect(parsed.entitlements["module.engagement"]).toBe(true);
  });

  it("parseAccess treats non-boolean values as false", () => {
    const raw = {
      permissions: {
        "service_times.manage": "true",
      },
      entitlements: {
        "module.engagement": 1,
      },
    };
    const parsed = parseAccess(raw);
    expect(parsed.permissions["service_times.manage"]).toBe(false);
    expect(parsed.entitlements["module.engagement"]).toBe(false);
  });

  it("defaultAccess has people.delete as false", () => {
    expect(defaultAccess.permissions["people.delete"]).toBe(false);
  });

  it("parseAccess reads people.delete only when it is true", () => {
    expect(
      parseAccess({ permissions: { "people.delete": true } }).permissions["people.delete"],
    ).toBe(true);
    expect(
      parseAccess({ permissions: { "people.delete": "true" } }).permissions["people.delete"],
    ).toBe(false);
    expect(parseAccess({ permissions: {} }).permissions["people.delete"]).toBe(false);
    expect(parseAccess(null).permissions["people.delete"]).toBe(false);
  });
});
