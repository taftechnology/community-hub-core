import { describe, expect, it } from "vitest";

import { healthModule } from "./health-module";

describe("health module", () => {
  it("publishes is empty", () => {
    expect(healthModule.publishes).toEqual([]);
  });
});
