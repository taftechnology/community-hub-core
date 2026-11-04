import { render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { TopBar } from "./top-bar";

describe("TopBar a11y", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  for (const theme of ["light", "dark"] as const) {
    it(`passes axe with no violations in ${theme} mode`, async () => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(
        <TopBar
          title="Screen Title"
          backHref="/previous"
          backLabel="Back"
          onMenu={() => {}}
          menuOpen={false}
          actions={<button type="button">Action</button>}
        />,
      );
      const results = await axe.run(container, {
        rules: {
          // Opaque token pairs are validated by @community-hub/check-tokens contrast rules.
          "color-contrast": { enabled: false },
        },
      });
      expect(results.violations).toEqual([]);
    });
  }
});
