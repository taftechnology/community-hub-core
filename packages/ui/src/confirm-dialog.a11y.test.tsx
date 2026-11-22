import { render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { ConfirmDialog } from "./confirm-dialog";

describe("ConfirmDialog a11y", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("ConfirmDialog has no axe violations and is named by its title", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.dataset.theme = theme;
      const { unmount } = render(
        <ConfirmDialog
          open
          onOpenChange={() => {}}
          title="Delete Alex Example?"
          description="They are hidden now."
          confirmLabel="Delete"
          cancelLabel="Keep"
          tone="danger"
          error="This contact was changed. Reload and try again."
          onConfirm={() => {}}
        />,
      );

      const dialog = screen.getByRole("dialog", { name: "Delete Alex Example?" });
      const describedBy = dialog.getAttribute("aria-describedby") ?? "";
      expect(document.getElementById(describedBy)?.textContent).toBe("They are hidden now.");

      const results = await axe.run(document.body, {
        rules: {
          // Opaque token pairs are validated by @community-hub/check-tokens contrast rules.
          "color-contrast": { enabled: false },
        },
      });
      expect(results.violations, theme).toEqual([]);
      unmount();
    }
  });
});
