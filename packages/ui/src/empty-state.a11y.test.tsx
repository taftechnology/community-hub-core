import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./empty-state.js";

describe("EmptyState a11y", () => {
  it("passes axe on standard empty state message", async () => {
    const { container } = render(<EmptyState message="No contacts yet" />);

    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});
