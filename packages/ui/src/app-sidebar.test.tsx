import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppSidebar, type SidebarItem } from "./app-sidebar";

const FROZEN_ITEMS: SidebarItem[] = [
  { id: "dashboard", label: "Dashboard", href: "/dashboard" },
  { id: "enquiries", label: "Enquiries", href: "/enquiries" },
  { id: "engagement", label: "Engagement", href: "/engagement" },
  {
    id: "contacts-members",
    label: "Contacts & Members",
    children: [{ id: "all-contacts", label: "All Contacts", href: "/contacts" }],
  },
  { id: "family-records", label: "Family Records", href: "/families" },
  { id: "membership", label: "Membership", href: "/membership" },
  { id: "records", label: "Records", href: "/records" },
  { id: "certifications", label: "Certifications", href: "/certifications" },
  { id: "volunteers", label: "Volunteers", href: "/volunteers" },
  { id: "forms", label: "Forms", href: "/forms" },
  { id: "communication", label: "Communication", href: "/communication" },
  { id: "mobile-app", label: "Mobile App", href: "/mobile-app" },
  { id: "website-cms", label: "Website & CMS", href: "/website" },
  { id: "donations", label: "Donations", href: "/donations" },
  { id: "ecommerce", label: "E-commerce", href: "/ecommerce" },
];

const FOOTER_ITEMS: SidebarItem[] = [
  {
    id: "settings",
    label: "Settings",
    children: [
      { id: "general-settings", label: "General Settings", href: "/settings/general" },
      { id: "users-roles", label: "Users & Roles", href: "/settings/roles" },
      { id: "module-toggles", label: "Module Toggles", href: "/settings/modules" },
    ],
  },
];

describe("AppSidebar", () => {
  it("renders 16 fixture items in exact input order for links and spans", () => {
    const sixteenItems: SidebarItem[] = [
      { id: "1", label: "Item 1", href: "/1" },
      { id: "2", label: "Item 2", href: "/2" },
      { id: "3", label: "Item 3", href: "/3" },
      { id: "4", label: "Item 4", href: "/4" },
      { id: "5", label: "Item 5", href: "/5" },
      { id: "6", label: "Item 6", href: "/6" },
      { id: "7", label: "Item 7", href: "/7" },
      { id: "8", label: "Item 8", href: "/8" },
      { id: "9", label: "Item 9", href: "/9" },
      { id: "10", label: "Item 10", href: "/10" },
      { id: "11", label: "Item 11", href: "/11" },
      { id: "12", label: "Item 12", href: "/12" },
      { id: "13", label: "Item 13", href: "/13" },
      { id: "14", label: "Item 14", href: "/14" },
      { id: "15", label: "Item 15", href: "/15" },
      { id: "16", label: "Item 16", href: "/16" },
    ];

    const { container } = render(
      <AppSidebar
        siteTitle="Community Hub"
        items={sixteenItems}
        footer={[]}
        renderLink={(item, props) => (
          <a href={item.href} {...props}>
            {item.label}
          </a>
        )}
      />,
    );

    const renderedTexts = Array.from(
      container.querySelectorAll("nav a, nav span[data-slot='nav-label']"),
    ).map((el) => el.textContent?.trim());

    const expectedLabels = sixteenItems.map((item) => item.label);
    expect(renderedTexts).toEqual(expectedLabels);
  });

  it("applies aria-current='page' only on activeId", () => {
    render(
      <AppSidebar
        siteTitle="Community Hub"
        items={FROZEN_ITEMS}
        footer={FOOTER_ITEMS}
        activeId="family-records"
        renderLink={(item, props) => (
          <a href={item.href} {...props}>
            {item.label}
          </a>
        )}
      />,
    );

    const currentLinks = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]?.textContent).toContain("Family Records");
  });

  it("shows no headings on a 7-row fixture", () => {
    const sevenRows: SidebarItem[] = [
      { id: "1", label: "Row 1", href: "/1", heading: "People" },
      { id: "2", label: "Row 2", href: "/2", heading: "People" },
      { id: "3", label: "Row 3", href: "/3", heading: "People" },
      { id: "4", label: "Row 4", href: "/4", heading: "Outreach" },
      { id: "5", label: "Row 5", href: "/5", heading: "Outreach" },
      { id: "6", label: "Row 6", href: "/6", heading: "Money" },
      { id: "7", label: "Row 7", href: "/7", heading: "Money" },
    ];

    const { container } = render(
      <AppSidebar
        siteTitle="Community Hub"
        items={sevenRows}
        footer={[]}
        renderLink={(item, props) => (
          <a href={item.href} {...props}>
            {item.label}
          </a>
        )}
      />,
    );

    const headings = container.querySelectorAll("[data-slot='nav-heading']");
    expect(headings.length).toBe(0);
    expect(screen.queryByText("People")).toBeNull();
    expect(screen.queryByText("Outreach")).toBeNull();
    expect(screen.queryByText("Money")).toBeNull();
  });

  it("shows headings on an 8-row fixture with items 4-9 (People), 10-13 (Outreach), 14-15 (Money)", () => {
    const sixteenItems: SidebarItem[] = [
      { id: "0", label: "Item 0", href: "/0" },
      { id: "1", label: "Item 1", href: "/1" },
      { id: "2", label: "Item 2", href: "/2" },
      { id: "3", label: "Item 3", href: "/3" },
      { id: "4", label: "Item 4", href: "/4", heading: "People" },
      { id: "5", label: "Item 5", href: "/5", heading: "People" },
      { id: "6", label: "Item 6", href: "/6", heading: "People" },
      { id: "7", label: "Item 7", href: "/7", heading: "People" },
      { id: "8", label: "Item 8", href: "/8", heading: "People" },
      { id: "9", label: "Item 9", href: "/9", heading: "People" },
      { id: "10", label: "Item 10", href: "/10", heading: "Outreach" },
      { id: "11", label: "Item 11", href: "/11", heading: "Outreach" },
      { id: "12", label: "Item 12", href: "/12", heading: "Outreach" },
      { id: "13", label: "Item 13", href: "/13", heading: "Outreach" },
      { id: "14", label: "Item 14", href: "/14", heading: "Money" },
      { id: "15", label: "Item 15", href: "/15", heading: "Money" },
    ];

    const { container } = render(
      <AppSidebar
        siteTitle="Community Hub"
        items={sixteenItems}
        footer={[]}
        renderLink={(item, props) => (
          <a href={item.href} {...props}>
            {item.label}
          </a>
        )}
      />,
    );

    const headings = Array.from(container.querySelectorAll("[data-slot='nav-heading']")).map((el) =>
      el.textContent?.trim(),
    );

    expect(headings).toEqual(["People", "Outreach", "Money"]);

    // Items order remains unchanged
    const links = Array.from(container.querySelectorAll("nav a")).map((el) =>
      el.textContent?.trim(),
    );
    expect(links).toEqual(sixteenItems.map((item) => item.label));
  });

  it("does not count footer items toward the 8 rows needed for headings", () => {
    const sevenRows: SidebarItem[] = [
      { id: "1", label: "Row 1", href: "/1", heading: "People" },
      { id: "2", label: "Row 2", href: "/2", heading: "People" },
      { id: "3", label: "Row 3", href: "/3", heading: "People" },
      { id: "4", label: "Row 4", href: "/4", heading: "Outreach" },
      { id: "5", label: "Row 5", href: "/5", heading: "Outreach" },
      { id: "6", label: "Row 6", href: "/6", heading: "Money" },
      { id: "7", label: "Row 7", href: "/7", heading: "Money" },
    ];

    const { container } = render(
      <AppSidebar
        siteTitle="Community Hub"
        items={sevenRows}
        footer={FOOTER_ITEMS}
        renderLink={(item, props) => (
          <a href={item.href} {...props}>
            {item.label}
          </a>
        )}
      />,
    );

    const headings = container.querySelectorAll("[data-slot='nav-heading']");
    expect(headings.length).toBe(0);
  });

  it("calls renderLink for every item and child with an href", () => {
    const renderLink = vi.fn((item, props) => (
      <a href={item.href} {...props}>
        {item.label}
      </a>
    ));

    render(
      <AppSidebar
        siteTitle="Community Hub"
        items={FROZEN_ITEMS}
        footer={FOOTER_ITEMS}
        renderLink={renderLink}
      />,
    );

    // Items without href (like Contacts & Members and Settings group labels) are spans
    expect(screen.getByText("Contacts & Members").tagName).toBe("SPAN");
    expect(screen.getByText("Settings").tagName).toBe("SPAN");

    // Children with href (All Contacts, General Settings, etc.) call renderLink
    expect(renderLink).toHaveBeenCalledWith(
      expect.objectContaining({ id: "all-contacts", href: "/contacts" }),
      expect.anything(),
    );
    expect(renderLink).toHaveBeenCalledWith(
      expect.objectContaining({ id: "general-settings", href: "/settings/general" }),
      expect.anything(),
    );
  });

  it("renders nothing with disabled or aria-disabled", () => {
    const { container } = render(
      <AppSidebar
        siteTitle="Community Hub"
        items={FROZEN_ITEMS}
        footer={FOOTER_ITEMS}
        renderLink={(item, props) => (
          <a href={item.href} {...props}>
            {item.label}
          </a>
        )}
      />,
    );

    expect(container.querySelectorAll("[disabled]")).toHaveLength(0);
    expect(container.querySelectorAll("[aria-disabled='true']")).toHaveLength(0);
  });

  it("renders the root nav with aria-label='Admin' and sidebar colors", () => {
    const { container } = render(
      <AppSidebar
        siteTitle="Community Hub"
        items={[]}
        footer={[]}
        renderLink={(item, props) => (
          <a href={item.href} {...props}>
            {item.label}
          </a>
        )}
      />,
    );

    const nav = container.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Admin");
    expect(nav?.className).toContain("bg-sidebar");
    expect(nav?.className).toContain("text-sidebar-foreground");
    expect(nav?.className).not.toContain("dark:");
  });
});
