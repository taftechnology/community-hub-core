import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { Avatar } from "./avatar.js";

describe("Avatar a11y", () => {
  it("passes axe on standard avatar initial badge", async () => {
    const { container } = render(<Avatar name="Mira Tolland" />);

    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});
