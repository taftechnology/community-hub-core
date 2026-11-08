import { render } from "@testing-library/react";
import axe from "axe-core";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { RestrictedValue } from "./restricted-value.js";

describe("RestrictedValue a11y", () => {
  it("passes axe with color-contrast disabled", async () => {
    const { container } = render(<RestrictedValue label="Household name hidden for your role" />);

    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});
