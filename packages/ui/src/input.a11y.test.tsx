import { render } from "@testing-library/react";
import axe from "axe-core";

import { Input } from "./input";

describe("Input", () => {
  it("passes axe when labeled", async () => {
    const { container } = render(
      <label>
        Search
        <Input type="text" />
      </label>,
    );
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });

  it("flags an input without an accessible name", async () => {
    const { container } = render(<Input type="text" />);
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations.map((v) => v.id)).toContain("label");
  });
});
