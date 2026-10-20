import { describe, expect, it } from "vitest";

import type { BillingState } from "./state.js";
import { BillingReadOnly, isWritable } from "./writable.js";

describe("isWritable", () => {
  it("allows invoiced, ok, retrying, and grace", () => {
    expect(isWritable("invoiced")).toBe(true);
    expect(isWritable("ok")).toBe(true);
    expect(isWritable("retrying")).toBe(true);
    expect(isWritable("grace")).toBe(true);
  });

  it("blocks none and read_only", () => {
    expect(isWritable("none")).toBe(false);
    expect(isWritable("read_only")).toBe(false);
  });

  it("handles every BillingState by name explicitly", () => {
    const states: Record<BillingState, boolean> = {
      invoiced: true,
      ok: true,
      retrying: true,
      grace: true,
      none: false,
      read_only: false,
    };

    for (const [state, expected] of Object.entries(states) as [BillingState, boolean][]) {
      expect(isWritable(state)).toBe(expected);
    }
  });
});

describe("BillingReadOnly", () => {
  it("carries the billing state and is an Error", () => {
    const error = new BillingReadOnly("read_only");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BillingReadOnly");
    expect(error.state).toBe("read_only");
    expect(error.message).toBe("Organisation is read-only");
    expect(error.message).not.toMatch(/\b(none|read_only|ok|grace|retrying|invoiced)\b/);

    const noneError = new BillingReadOnly("none");
    expect(noneError.state).toBe("none");
    expect(noneError.message).toBe("Organisation is read-only");
    expect(noneError.message).not.toMatch(/\b(none|read_only|ok|grace|retrying|invoiced)\b/);
  });
});
