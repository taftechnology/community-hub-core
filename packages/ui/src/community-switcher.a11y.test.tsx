import { render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { CommunitySwitcher } from "./community-switcher";

describe("CommunitySwitcher a11y", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  const communities = [
    { id: "comm-1", label: "St Mary" },
    { id: "comm-2", label: "St Patrick" },
  ];

  for (const theme of ["light", "dark"] as const) {
    it(`passes axe with no violations in ${theme} mode`, async () => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(
        <CommunitySwitcher communities={communities} currentId="comm-1" onChange={() => {}} />,
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
