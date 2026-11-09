import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { Skeleton } from "./skeleton.js";

describe("Skeleton a11y", () => {
  it("passes axe on standard skeleton placeholder", async () => {
    const { container } = render(<Skeleton lines={3} />);

    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});
