import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { FilterBar } from "./filter-bar.js";

describe("FilterBar a11y", () => {
  it("passes axe on standard search form layout", async () => {
    const { container } = render(
      <FilterBar
        label="Search contacts"
        value="Mira Tolland"
        onValueChange={() => {}}
        onSubmit={(e) => e.preventDefault()}
      />,
    );

    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});
