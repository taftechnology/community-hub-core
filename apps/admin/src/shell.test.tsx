import { fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";

import { labels } from "./labels";
import { Shell } from "./shell";

const frozenLabels = [
  "Dashboard",
  "Enquires",
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

it("renders Dashboard and Users & Roles from the frozen labels", () => {
  expect(labels).toEqual(frozenLabels);

  render(<Shell />);

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

  const headings = screen.getAllByRole("heading", { level: 1 });
  expect(headings).toHaveLength(1);
  expect(headings[0]?.textContent).toBe("Dashboard");

  for (const label of frozenLabels) {
    if (label === "Dashboard" || label === "Settings") {
      continue;
    }
    expect(screen.queryByText(label)).toBeNull();
  }
  expect(screen.queryByText("Email Settings")).toBeNull();
});

it("names Refresh and reports no axe violations", async () => {
  const { container } = render(<Shell />);
  expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();

  const results = await axe.run(container, {
    rules: {
      "color-contrast": { enabled: false },
    },
  });

  expect(resultIds(results, "violations")).toEqual([]);
});

it("renders the community picker in the shell with no axe violations", async () => {
  const { container } = render(<Shell />);
  expect(screen.getByRole("textbox", { name: "Community" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Set" })).toBeTruthy();

  const results = await axe.run(container, {
    rules: {
      "color-contrast": { enabled: false },
    },
  });

  expect(resultIds(results, "violations")).toEqual([]);
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

it("reloads the document and does not call fetch", () => {
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
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(reload).toHaveBeenCalledOnce();
  fetchSpy.mockRestore();
  vi.unstubAllGlobals();
});
