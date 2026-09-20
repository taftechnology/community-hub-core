import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEvent } from "./event";

describe("defineEvent", () => {
  it("rejects a name that does not match EVENT_NAME_RE", () => {
    expect(() =>
      defineEvent({
        name: "not-an-event",
        payload: z.object({ personId: z.string() }),
      }),
    ).toThrow();
  });
});
