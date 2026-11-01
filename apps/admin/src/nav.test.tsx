import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { AdminNav } from "./nav";
import { PeopleAccessContext, type PeopleAccess } from "./people-access";

function renderNav(access: Partial<PeopleAccess> = {}) {
  const fullAccess: PeopleAccess = {
    permissions: {
      "people.view": false,
      "people.manage": false,
      "people.restricted.read": false,
      ...access.permissions,
    },
    entitlements: {
      "people.directory": false,
      "people.households": false,
      ...access.entitlements,
    },
  };

  return render(
    <MemoryRouter>
      <PeopleAccessContext.Provider value={{ access: fullAccess }}>
        <AdminNav />
      </PeopleAccessContext.Provider>
    </MemoryRouter>,
  );
}

describe("AdminNav", () => {
  it("renders Contacts & Members link when caller has people.directory and people.view", () => {
    renderNav({
      permissions: {
        "people.view": true,
        "people.manage": false,
        "people.restricted.read": false,
      },
      entitlements: {
        "people.directory": true,
        "people.households": false,
      },
    });

    expect(screen.getByText("Contacts & Members")).toBeTruthy();
    expect(screen.getByRole("link", { name: "All Contacts" })).toBeTruthy();
  });

  it("hides Contacts & Members when caller lacks people.directory", () => {
    renderNav({
      permissions: {
        "people.view": true,
        "people.manage": false,
        "people.restricted.read": false,
      },
      entitlements: {
        "people.directory": false,
        "people.households": true,
      },
    });

    expect(screen.queryByText("Contacts & Members")).toBeNull();
    expect(screen.queryByRole("link", { name: "All Contacts" })).toBeNull();
  });

  it("hides Contacts & Members when caller lacks people.view", () => {
    renderNav({
      permissions: {
        "people.view": false,
        "people.manage": true,
        "people.restricted.read": false,
      },
      entitlements: {
        "people.directory": true,
        "people.households": true,
      },
    });

    expect(screen.queryByText("Contacts & Members")).toBeNull();
    expect(screen.queryByRole("link", { name: "All Contacts" })).toBeNull();
  });

  it("renders Family Records as a span when caller has people.households and people.view (Pin 21)", () => {
    renderNav({
      permissions: {
        "people.view": true,
        "people.manage": false,
        "people.restricted.read": false,
      },
      entitlements: {
        "people.directory": false,
        "people.households": true,
      },
    });

    const el = screen.getByText("Family Records");
    expect(el).toBeTruthy();
    expect(el.tagName).toBe("SPAN");
    expect(screen.queryByRole("link", { name: "Family Records" })).toBeNull();
  });

  it("hides Family Records when caller lacks people.households (Pin 21)", () => {
    renderNav({
      permissions: {
        "people.view": true,
        "people.manage": false,
        "people.restricted.read": false,
      },
      entitlements: {
        "people.directory": false,
        "people.households": false,
      },
    });

    expect(screen.queryByText("Family Records")).toBeNull();
  });

  it("hides Family Records when caller lacks people.view (Pin 21)", () => {
    renderNav({
      permissions: {
        "people.view": false,
        "people.manage": false,
        "people.restricted.read": false,
      },
      entitlements: {
        "people.directory": false,
        "people.households": true,
      },
    });

    expect(screen.queryByText("Family Records")).toBeNull();
  });
});
