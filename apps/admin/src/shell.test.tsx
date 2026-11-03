import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { StrictMode } from "react";
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

  it("without a handle, renders a 'Sign in' link to /sign-in and no Account button", () => {
    sessionStorage.removeItem("community-hub.signout-handle");
    render(<Shell />);

    const header = screen.getByRole("banner");
    const signInLink = within(header).getByRole("link", { name: /sign in/i });
    expect(signInLink).toBeTruthy();
    expect(signInLink.getAttribute("href")).toBe("/sign-in");
    expect(within(header).queryByRole("button", { name: "Account" })).toBeNull();
  });

  it("with a handle, renders an 'Account' button that opens menu with 'Sign out', and clicking Sign out twice quickly sends one POST", async () => {
    sessionStorage.setItem("community-hub.signout-handle", "fake-" + "handle-1");
    vi.stubEnv("VITE_AUTH_ORIGIN", "https://au.auth.example.test");
    vi.stubEnv("VITE_API_ORIGIN", "https://au.api.example.test");

    const location = window.location;
    const assignMock = vi.fn();
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
      assign: assignMock,
      replace: location.replace.bind(location),
      reload: location.reload.bind(location),
    });

    let resolveFetch!: (res: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => pendingFetch);

    render(<Shell />);

    const header = screen.getByRole("banner");
    expect(within(header).queryByRole("link", { name: "Sign in" })).toBeNull();

    const accountBtn = within(header).getByRole("button", { name: "Account" });
    expect(accountBtn).toBeTruthy();

    fireEvent.click(accountBtn);

    const signOutBtn = await screen.findByRole("menuitem", { name: "Sign out" });
    expect(signOutBtn).toBeTruthy();

    // Fast double click
    fireEvent.click(signOutBtn);
    fireEvent.click(signOutBtn);

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Resolve the in-flight fetch
    await act(async () => {
      resolveFetch(new Response(null, { status: 204 }));
    });

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith("/sign-in");
    });
  });

  it("render once inside <StrictMode> and assert a single POST per click", async () => {
    sessionStorage.setItem("community-hub.signout-handle", "fake-" + "handle-2");
    vi.stubEnv("VITE_AUTH_ORIGIN", "https://au.auth.example.test");
    vi.stubEnv("VITE_API_ORIGIN", "https://au.api.example.test");

    const location = window.location;
    const assignMock = vi.fn();
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
      assign: assignMock,
      replace: location.replace.bind(location),
      reload: location.reload.bind(location),
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    render(
      <StrictMode>
        <Shell />
      </StrictMode>,
    );

    const accountBtn = screen.getByRole("button", { name: "Account" });
    fireEvent.click(accountBtn);

    const signOutBtn = await screen.findByRole("menuitem", { name: "Sign out" });
    fireEvent.click(signOutBtn);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith("/sign-in");
    });
  });

  it("axe reports no violations on shell with the user menu open in light and dark", async () => {
    sessionStorage.setItem("community-hub.signout-handle", "fake-" + "handle-3");
    const { container } = render(<Shell />);

    const accountBtn = screen.getByRole("button", { name: "Account" });
    await act(async () => {
      fireEvent.click(accountBtn);
    });
    const popup = await screen.findByRole("menu");
    expect(popup).toBeTruthy();

    // Test in light mode
    const lightResults = await axe.run([container, popup], {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(resultIds(lightResults, "violations")).toEqual([]);

    // Test in dark mode
    act(() => {
      document.documentElement.dataset.theme = "dark";
    });

    const darkResults = await axe.run([container, popup], {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(resultIds(darkResults, "violations")).toEqual([]);
  });

  it("user menu contains Dark mode toggle for phones in extraItems that toggles theme", async () => {
    sessionStorage.setItem("community-hub.signout-handle", "fake-" + "handle-4");
    render(<Shell />);

    const accountBtn = screen.getByRole("button", { name: "Account" });
    await act(async () => {
      fireEvent.click(accountBtn);
    });

    const darkToggle = await screen.findByRole("menuitemcheckbox", { name: "Dark mode" });
    expect(darkToggle).toBeTruthy();
    expect(darkToggle.getAttribute("aria-checked")).toBe("false");
    expect(darkToggle.className).toContain("sm:hidden");

    const popup = screen.getByRole("menu");
    while (!darkToggle.hasAttribute("data-highlighted") && document.activeElement !== darkToggle) {
      fireEvent.keyDown(document.activeElement ?? popup, { key: "ArrowDown" });
    }
    expect(
      darkToggle.hasAttribute("data-highlighted") || document.activeElement === darkToggle,
    ).toBe(true);

    fireEvent.keyDown(darkToggle, { key: "Enter" });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("community-hub.theme")).toBe("dark");
    expect(darkToggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(darkToggle, { key: "Enter" });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("community-hub.theme")).toBe("light");
    expect(darkToggle.getAttribute("aria-checked")).toBe("false");

    const signOutBtn = screen.getByRole("menuitem", { name: "Sign out" });
    fireEvent.keyDown(darkToggle, { key: "ArrowDown" });
    expect(
      signOutBtn.hasAttribute("data-highlighted") || document.activeElement === signOutBtn,
    ).toBe(true);
  });
});
