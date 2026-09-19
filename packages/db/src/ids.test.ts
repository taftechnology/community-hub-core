import { describe, expect, it } from "vitest";

import { newId } from "./ids.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
  it("returns an RFC 9562 UUIDv7", () => {
    expect(newId()).toMatch(UUID_V7);
  });
});
