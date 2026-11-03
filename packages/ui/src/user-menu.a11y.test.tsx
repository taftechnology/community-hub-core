import { render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { UserMenu } from "./user-menu";

describe("UserMenu a11y", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  for (const theme of ["light", "dark"] as const) {
    it(`passes axe with no violations in ${theme} mode when signed out`, async () => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(
        <UserMenu signedIn={false} signInHref="/sign-in" onSignOut={() => {}} />,
      );
      const results = await axe.run(container, {
        rules: {
          // Opaque token pairs are validated by @community-hub/check-tokens contrast rules.
          "color-contrast": { enabled: false },
        },
      });
      expect(results.violations).toEqual([]);
    });

    it(`passes axe with no violations in ${theme} mode when signed in`, async () => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(
        <UserMenu signedIn={true} signInHref="/sign-in" onSignOut={() => {}} />,
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
