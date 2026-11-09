import { render } from "@testing-library/react";
import axe from "axe-core";

import { DescriptionList } from "./description-list.js";

describe("DescriptionList accessibility", () => {
  it("passes axe on standard description list structure", async () => {
    const items = [
      { term: "Plan", value: "Community Starter" },
      { term: "Quantity", value: "1" },
    ];
    const { container } = render(<DescriptionList items={items} />);
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});
