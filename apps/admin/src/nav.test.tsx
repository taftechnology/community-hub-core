import { terminology } from "@community-hub/faith-church";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { AdminNav, findActiveId } from "./nav";
import { PeopleAccessContext, type PeopleAccess } from "./people-access";

function renderNav(
  access: {
    permissions?: Partial<PeopleAccess["permissions"]>;
    entitlements?: Partial<PeopleAccess["entitlements"]>;
  } = {},
) {
  const fullAccess: PeopleAccess = {
    permissions: {
      "people.view": false,
      "people.manage": false,
      "people.restricted.read": false,
      "service_times.manage": false,
      ...access.permissions,
    },
    entitlements: {
      "people.directory": false,
      "people.households": false,
      "module.engagement": false,
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

  it("renders Family Records as a link when caller has people.households and people.view (Pin 21)", () => {
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

    const el = screen.getByRole("link", { name: "Family Records" });
    expect(el).toBeTruthy();
    expect(el.getAttribute("href")).toBe("/family-records");
  });

  it("hides Family Records when caller has people.restricted.read but lacks people.view (Pin 21)", () => {
    renderNav({
      permissions: {
        "people.view": false,
        "people.manage": false,
        "people.restricted.read": true,
      },
      entitlements: {
        "people.directory": false,
        "people.households": true,
      },
    });

    expect(screen.queryByText("Family Records")).toBeNull();
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

  it("renders Engagement and service-times child with pack plural when caller has module.engagement and service_times.manage", () => {
    const plural = terminology("engagement.service_times").plural;
    renderNav({
      permissions: {
        "service_times.manage": true,
      },
      entitlements: {
        "module.engagement": true,
      },
    });

    expect(screen.getByText("Engagement")).toBeTruthy();
    const link = screen.getByRole("link", { name: plural });
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("/engagement/service-times");
  });

  it("hides Engagement parent and child when caller has module.engagement but lacks service_times.manage (Pin 26)", () => {
    const plural = terminology("engagement.service_times").plural;
    renderNav({
      permissions: {
        "service_times.manage": false,
      },
      entitlements: {
        "module.engagement": true,
      },
    });

    expect(screen.queryByText("Engagement")).toBeNull();
    expect(screen.queryByRole("link", { name: plural })).toBeNull();
  });

  it("hides Engagement parent and child when caller has service_times.manage but lacks module.engagement", () => {
    const plural = terminology("engagement.service_times").plural;
    renderNav({
      permissions: {
        "service_times.manage": true,
      },
      entitlements: {
        "module.engagement": false,
      },
    });

    expect(screen.queryByText("Engagement")).toBeNull();
    expect(screen.queryByRole("link", { name: plural })).toBeNull();
  });

  it("findActiveId selects service-times on /engagement/service-times", () => {
    const plural = terminology("engagement.service_times").plural;
    const items = [
      {
        id: "engagement",
        label: "Engagement",
        children: [
          {
            id: "service-times",
            label: plural,
            href: "/engagement/service-times",
          },
        ],
      },
    ];
    expect(findActiveId(items, [], "/engagement/service-times")).toBe("service-times");
  });
});
