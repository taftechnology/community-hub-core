import { render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { Drawer } from "./drawer";

describe("Drawer a11y", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  for (const theme of ["light", "dark"] as const) {
    it(`passes axe with no violations in ${theme} mode`, async () => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(
        <Drawer open={true} onOpenChange={() => {}} label="Menu">
          <nav aria-label="Mobile navigation">
            <ul>
              <li>
                <a href="#link">Link item</a>
              </li>
            </ul>
          </nav>
        </Drawer>,
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
