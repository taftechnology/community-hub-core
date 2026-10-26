import { describe, expect, it } from "vitest";

import * as ns from "../public/index.js";

describe("operator-exports", () => {
  it("does not export the internal operator helpers", () => {
    const exports = Object.keys(ns);
    expect(exports).not.toContain("lockOperatorUser");
    expect(exports).not.toContain("appendOperatorEvent");
  });
});
