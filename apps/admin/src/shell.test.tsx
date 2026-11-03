import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { labels } from "./labels";
import { PeopleAccessContext, type PeopleAccess } from "./people-access";
import { router, Shell } from "./shell";
import { ShellLayout } from "./shell-layout";
import { MemoryRouter } from "react-router";

const frozenLabels = [
  "Dashboard",
  "Enquiries",
  "Engagement",
  "Contacts & Members",
  "Family Records",
  "Membership",
  "Records",
  "Certifications",
  "Volunteers",
  "Forms",
  "Communication",
  "Mobile App",
  "Website & CMS",
  "Donations",
  "E-commerce",
  "Settings",
] as const;

function resultIds(
  results: axe.AxeResults,
  bucket: "passes" | "violations" | "incomplete" | "inapplicable",
): string[] {
  return results[bucket].map((entry) => entry.id);
}

function UnnamedButton() {
  return <button type="button" />;
}

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => {
      store.set(key, String(val));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

describe("Shell and ShellLayout", () => {
  let storage: Storage;

  beforeEach(async () => {
    storage = createStorage();
    vi.stubGlobal("localStorage", storage);
    sessionStorage.clear();
    delete document.documentElement.dataset.theme;
    await router.navigate("/");
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    delete document.documentElement.dataset.theme;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("labels equals frozenLabels, with Enquiries", () => {
    expect(labels).toEqual(frozenLabels);
    expect(labels[1]).toBe("Enquiries");
  });

  it("with no entitlements, the navigation named Admin lists links in order and contains slug controls", () => {
    const { container } = render(<Shell />);

    const nav = screen.getByRole("navigation", { name: "Admin" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Dashboard",
      "General Settings",
      "Users & Roles",
      "Module Toggles",
    ]);

    expect(within(nav).getByRole("link", { name: "Dashboard" }).getAttribute("href")).toBe("/");
    expect(within(nav).getByRole("link", { name: "General Settings" }).getAttribute("href")).toBe(
      "/settings/general",
    );
    expect(within(nav).getByRole("link", { name: "Users & Roles" }).getAttribute("href")).toBe(
      "/settings/users",
    );
    expect(within(nav).getByRole("link", { name: "Module Toggles" }).getAttribute("href")).toBe(
      "/settings/modules",
    );
    expect(within(nav).getByText("Settings").tagName).not.toBe("A");
    expect(within(nav).queryByRole("link", { name: "Settings" })).toBeNull();

    // The slug textbox and Set button are inside the Admin navigation
    expect(within(nav).getByRole("textbox", { name: "Community" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Set" })).toBeTruthy();

    // Exactly one h1 on /, and it is inside the top bar
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe("Dashboard");
    const header = container.querySelector("header");
    expect(header).toBeTruthy();
    expect(within(header!).getByRole("heading", { level: 1 })).toBe(headings[0]);

    // document.title is "Dashboard · Community Hub"
    expect(document.title).toBe("Dashboard · Community Hub");

    for (const label of frozenLabels) {
      if (label === "Dashboard" || label === "Settings") {
        continue;
      }
      expect(screen.queryByText(label)).toBeNull();
    }
    expect(screen.queryByText("Email Settings")).toBeNull();

    // No section-heading text appears for real users
    expect(screen.queryByText("People")).toBeNull();
    expect(screen.queryByText("Outreach")).toBeNull();
    expect(screen.queryByText("Money")).toBeNull();
  });

  it("with full people entitlements and people.view, link order follows pin 15", () => {
    const fullAccess: PeopleAccess = {
      permissions: {
        "people.view": true,
        "people.manage": true,
        "people.restricted.read": true,
      },
      entitlements: {
        "people.directory": true,
        "people.households": true,
      },
    };

    render(
      <MemoryRouter initialEntries={["/"]}>
        <PeopleAccessContext.Provider value={{ access: fullAccess }}>
          <ShellLayout />
        </PeopleAccessContext.Provider>
      </MemoryRouter>,
    );

    const nav = screen.getByRole("navigation", { name: "Admin" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Dashboard",
      "All Contacts",
      "Family Records",
      "General Settings",
      "Users & Roles",
      "Module Toggles",
    ]);

    expect(within(nav).getByText("Settings").tagName).not.toBe("A");
    expect(within(nav).queryByRole("link", { name: "Settings" })).toBeNull();

    const groupText = within(nav).getByText("Contacts & Members");
    const allContactsLink = within(nav).getByRole("link", {
      name: "All Contacts",
    });
    expect(
      groupText.compareDocumentPosition(allContactsLink) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    for (const label of frozenLabels) {
      if (
        label === "Dashboard" ||
        label === "Settings" ||
        label === "Contacts & Members" ||
        label === "Family Records"
      ) {
        continue;
      }
      expect(screen.queryByText(label)).toBeNull();
    }
    expect(screen.queryByText("Email Settings")).toBeNull();

    // No section-heading text appears for real users (4 middle rows < 8)
    expect(screen.queryByText("People")).toBeNull();
    expect(screen.queryByText("Outreach")).toBeNull();
    expect(screen.queryByText("Money")).toBeNull();
  });

  it("theme toggle: clicking Dark mode sets data-theme to dark and stores it", () => {
    render(<Shell />);

    // With nothing stored, data-theme is not set on load
    expect(document.documentElement.dataset.theme).toBeUndefined();

    const toggleBtn = screen.getByRole("button", { name: "Dark mode" });
    fireEvent.click(toggleBtn);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("community-hub.theme")).toBe("dark");

    fireEvent.click(toggleBtn);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("community-hub.theme")).toBe("light");
  });

  it("drawer: below lg the menu button opens Menu dialog, choosing a link closes it and focuses top-bar h1", async () => {
    const { container } = render(<Shell />);

    const menuBtn = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(menuBtn);

    const dialog = screen.getByRole("dialog", { name: "Menu" });
    expect(dialog).toBeTruthy();

    const link = within(dialog).getByRole("link", { name: "Dashboard" });
    fireEvent.click(link);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    const topBarH1 = container.querySelector("header h1");
    expect(topBarH1).toBeTruthy();
    expect(document.activeElement).toBe(topBarH1);
  });

  it("axe reports no violations on the full shell in light and dark", async () => {
    const { container } = render(<Shell />);

    const lightResults = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(resultIds(lightResults, "violations")).toEqual([]);

    act(() => {
      document.documentElement.dataset.theme = "dark";
    });

    const darkResults = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(resultIds(darkResults, "violations")).toEqual([]);
  });

  it("reloads the document on Refresh click and does not call fetch", () => {
    const reload = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("fetch called");
    });
    const location = window.location;
    vi.stubGlobal("location", {
      ancestorOrigins: location.ancestorOrigins,
      href: location.href,
      origin: location.origin,
      protocol: location.protocol,
      host: location.host,
      hostname: location.hostname,
      port: location.port,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
      assign: location.assign.bind(location),
      replace: location.replace.bind(location),
      reload,
    });

    render(<Shell />);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("flags a control with no accessible name", async () => {
    const { container } = render(<UnnamedButton />);
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });

    expect(resultIds(results, "violations")).toContain("button-name");
  });
});
