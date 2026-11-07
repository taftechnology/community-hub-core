import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { Checkbox } from "./checkbox.js";

describe("Checkbox a11y", () => {
  it("passes axe with label", async () => {
    const { container } = render(<Checkbox label="Enable notifications" />);
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });

  it("passes axe when checked and disabled", async () => {
    const { container } = render(<Checkbox label="Admin privileges" checked readOnly disabled />);
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});
