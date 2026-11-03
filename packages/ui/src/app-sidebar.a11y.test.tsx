import { render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { AppSidebar, type SidebarItem } from "./app-sidebar";

const ITEMS: SidebarItem[] = [
  { id: "dashboard", label: "Dashboard", href: "/dashboard" },
  {
    id: "people",
    label: "People Group",
    children: [{ id: "contacts", label: "Contacts", href: "/contacts" }],
  },
];

const FOOTER: SidebarItem[] = [{ id: "settings", label: "Settings", href: "/settings" }];

describe("AppSidebar a11y", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  for (const theme of ["light", "dark"] as const) {
    it(`passes axe with no violations in ${theme} mode`, async () => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(
        <AppSidebar
          siteTitle="Community Hub"
          items={ITEMS}
          footer={FOOTER}
          activeId="dashboard"
          renderLink={(item, props) => (
            <a href={item.href} {...props}>
              {item.label}
            </a>
          )}
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
