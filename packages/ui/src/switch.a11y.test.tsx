import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { Switch } from "./switch.js";

describe("Switch a11y", () => {
  it("passes axe with label", async () => {
    const { container } = render(<Switch label="Enable module" />);
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });

  it("passes axe when checked and disabled", async () => {
    const { container } = render(<Switch label="Active module" checked readOnly disabled />);
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});
