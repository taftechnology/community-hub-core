import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { Panel } from "./panel.js";

describe("Panel a11y", () => {
  it("passes axe with title and children", async () => {
    const { container } = render(
      <Panel title="User Profile">
        <p>Profile information</p>
      </Panel>,
    );
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });

  it("passes axe untitled with actions and footer", async () => {
    const { container } = render(
      <Panel
        actions={<button type="button">Refresh</button>}
        footer={<button type="button">Save</button>}
      >
        <p>Settings content</p>
      </Panel>,
    );
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});
