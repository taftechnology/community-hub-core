import { describe, expect, it } from "vitest";

import { healthPayload } from "./health";

describe("healthPayload", () => {
  it("returns exactly { ok: true }", () => {
    expect(healthPayload()).toEqual({ ok: true });
  });
});
