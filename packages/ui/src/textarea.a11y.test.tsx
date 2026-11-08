import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { Textarea } from "./textarea";

describe("Textarea a11y", () => {
  it("passes axe when labeled", async () => {
    const { container } = render(
      <label>
        Comments
        <Textarea />
      </label>,
    );
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });

  it("flags a textarea without an accessible name", async () => {
    const { container } = render(<Textarea />);
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations.map((v) => v.id)).toContain("label");
  });
});
