import { describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";

describe("logger compile-time field typing", () => {
  it("documents @ts-expect-error below for pnpm typecheck", () => {
    const logger = createLogger({ write: () => {} });
    const untyped: Record<string, unknown> = {
      method: "GET",
      path: "/health",
    };

    // @ts-expect-error untyped records must not be accepted by the logger API
    logger.info("request", untyped);

    expect(logger.getDroppedFieldCount()).toBe(0);
  });
});
