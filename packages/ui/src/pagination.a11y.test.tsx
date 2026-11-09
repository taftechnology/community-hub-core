import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { Pagination } from "./pagination.js";

describe("Pagination a11y", () => {
  it("passes axe when rendering cursor pagination control", async () => {
    const { container } = render(<Pagination cursor="cursor_abc123" onNext={() => {}} />);

    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});
