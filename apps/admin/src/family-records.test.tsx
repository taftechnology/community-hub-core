import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BillingStatusProvider } from "./billing-status";
import { CommunityProvider } from "./community";
import { FamilyRecordsPage, MinorsSection } from "./family-records";
import { type PeopleAccess, PeopleAccessContext } from "./people-access";
import { router, Shell } from "./shell";

const SLUG = "test-community";
const TOKEN = "synthetic.access.token";

function resultIds(
  results: axe.AxeResults,
  bucket: "passes" | "violations" | "incomplete" | "inapplicable",
): string[] {
  return results[bucket].map((entry) => entry.id);
}

type CapabilitiesInput =
  | {
      directoryEnabled?: boolean;
      householdsEnabled?: boolean;
      canView?: boolean;
      canManage?: boolean;
      canReadMinors?: boolean;
    }
  | number;

function mockCapabilitiesResponse(input: CapabilitiesInput = {}): Response {
  if (typeof input === "number") {
    return new Response(
      JSON.stringify({
        permissions: {
          "people.view": true,
          "people.manage": true,
          "people.restricted.read": true,
        },
        entitlements: {
          "people.directory": true,
          "people.households": true,
        },
      }),
      {
        status: input,
        headers: { "content-type": "application/json" },
      },
    );
  }
  return new Response(
    JSON.stringify({
      permissions: {
        "people.view": input.canView ?? true,
        "people.manage": input.canManage ?? true,
        "people.restricted.read": input.canReadMinors ?? true,
      },
      entitlements: {
        "people.directory": input.directoryEnabled ?? true,
        "people.households": input.householdsEnabled ?? true,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

type MockApiOptions = {
  access?: CapabilitiesInput;
  billingStatus?:
    { state: string; canView: boolean; canManage: boolean } | number | Promise<Response>;
  listResult?: { items: unknown[]; nextCursor: string | null } | number;
  detailResult?: unknown | number;
  createResult?: unknown | number;
  renameResult?: unknown | number;
  moveAdultResult?: unknown | number;
  addAdultResult?: unknown | number | "network";
  addMinorResult?: unknown | number;
  linkGuardianResult?: unknown | number;
  unlinkGuardianResult?: unknown | number;
  peopleListResult?: { items: unknown[]; nextCursor: string | null } | number;
  lifeEventsListResult?: { items: unknown[] } | number;
  onPost?: (path: string, body: unknown) => void;
};

function mockApi({
  access = {},
  billingStatus,
  listResult = { items: [], nextCursor: null },
  detailResult,
  createResult,
  renameResult,
  moveAdultResult,
  addAdultResult,
  addMinorResult,
  linkGuardianResult,
  unlinkGuardianResult,
  peopleListResult = { items: [], nextCursor: null },
  lifeEventsListResult,
  onPost,
}: MockApiOptions = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
    const url = String(info);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    let body: unknown = undefined;
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = undefined;
      }
    }

    if (path === "/v1/access/capabilities") {
      return mockCapabilitiesResponse(access);
    }

    if (path === "/v1/households/list") {
      if (onPost) onPost(path, body);
      if (typeof listResult === "number") {
        return new Response(null, { status: listResult });
      }
      return new Response(JSON.stringify(listResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (path === "/v1/households/read") {
      if (onPost) onPost(path, body);
      if (typeof detailResult === "number") {
        return new Response(null, { status: detailResult });
      }
      if (detailResult !== undefined) {
        return new Response(JSON.stringify(detailResult), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    }

    if (path === "/v1/households/create") {
      if (onPost) onPost(path, body);
      if (typeof createResult === "number") {
        return new Response(null, { status: createResult });
      }
      return new Response(
        JSON.stringify(
          createResult ?? {
            householdId: "00000000-0000-4000-8000-000000000099",
            version: 1,
          },
        ),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }

    if (path === "/v1/households/rename") {
      if (onPost) onPost(path, body);
      if (typeof renameResult === "number") {
        return new Response(null, { status: renameResult });
      }
      return new Response(JSON.stringify(renameResult ?? { version: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (path === "/v1/households/members/move-adult") {
      if (onPost) onPost(path, body);
      if (typeof moveAdultResult === "number") {
        return new Response(null, { status: moveAdultResult });
      }
      return new Response(JSON.stringify(moveAdultResult ?? { version: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (path === "/v1/households/members/add-adult") {
      if (onPost) onPost(path, body);
      if (addAdultResult === "network") {
        throw new TypeError("network down");
      }
      if (typeof addAdultResult === "number") {
        return new Response(null, { status: addAdultResult });
      }
      return new Response(
        JSON.stringify(addAdultResult ?? { personId: "00000000-0000-4000-8000-000000000066" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }

    if (path === "/v1/households/members/add-minor") {
      if (onPost) onPost(path, body);
      if (typeof addMinorResult === "number") {
        return new Response(null, { status: addMinorResult });
      }
      return new Response(
        JSON.stringify(
          addMinorResult ?? {
            personId: "00000000-0000-4000-8000-000000000088",
            linkId: "00000000-0000-4000-8000-000000000077",
          },
        ),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }

    if (path === "/v1/households/guardians/link") {
      if (onPost) onPost(path, body);
      if (typeof linkGuardianResult === "number") {
        return new Response(null, { status: linkGuardianResult });
      }
      return new Response(
        JSON.stringify(
          linkGuardianResult ?? {
            linkId: "00000000-0000-4000-8000-000000000077",
          },
        ),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }

    if (path === "/v1/households/guardians/unlink") {
      if (onPost) onPost(path, body);
      if (typeof unlinkGuardianResult === "number") {
        return new Response(null, { status: unlinkGuardianResult });
      }
      return new Response(JSON.stringify(unlinkGuardianResult ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (path === "/v1/people/list") {
      if (onPost) onPost(path, body);
      if (typeof peopleListResult === "number") {
        return new Response(null, { status: peopleListResult });
      }
      return new Response(JSON.stringify(peopleListResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (path === "/v1/people/life-events/list") {
      if (onPost) onPost(path, body);
      if (typeof lifeEventsListResult === "number") {
        return new Response(null, { status: lifeEventsListResult });
      }
      return new Response(JSON.stringify(lifeEventsListResult ?? { items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (path === "/v1/billing/status") {
      if (billingStatus instanceof Promise) {
        return billingStatus;
      }
      if (typeof billingStatus === "number") {
        return new Response(null, { status: billingStatus });
      }
      return new Response(
        JSON.stringify(
          billingStatus ?? {
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          },
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    return new Response(null, { status: 404 });
  });
}

async function showFamilyRecords(): Promise<HTMLElement> {
  await router.navigate("/family-records");
  const view = render(<Shell />);
  return view.container;
}

beforeEach(async () => {
  sessionStorage.clear();
  await router.navigate("/");
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Admin Nav Family Records item (Pin 21)", () => {
  it("hides Family Records when people.households is disabled", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({ access: { householdsEnabled: false, canView: true, canReadMinors: true } });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await act(async () => {});
    const nav = screen.getByRole("navigation", { name: "Admin" });
    expect(within(nav).queryByText("Family Records")).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Family Records" })).toBeNull();
  });

  it("hides Family Records when caller lacks people.view even if canManage is true", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: false, canManage: true, canReadMinors: false },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await act(async () => {});
    const nav = screen.getByRole("navigation", { name: "Admin" });
    expect(within(nav).queryByText("Family Records")).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Family Records" })).toBeNull();
  });

  it("hides Family Records when caller is safeguarding officer (restricted.read only, lacks people.view)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: false, canManage: false, canReadMinors: true },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await act(async () => {});
    const nav = screen.getByRole("navigation", { name: "Admin" });
    expect(within(nav).queryByText("Family Records")).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Family Records" })).toBeNull();
  });

  it("shows Family Records as a link when caller has people.households and people.view", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({ access: { householdsEnabled: true, canView: true, canReadMinors: false } });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const nav = screen.getByRole("navigation", { name: "Admin" });
    const link = await within(nav).findByRole("link", { name: "Family Records" });
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("/family-records");
  });
});

describe("Authentication & capabilities gating for Family Records page", () => {
  it("shows sign in required when token is missing", async () => {
    mockApi();
    await showFamilyRecords();

    expect(await screen.findByText("Sign in required")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
  });

  it("shows Not allowed when caller lacks people.households entitlement", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let accessCalls = 0;
    let listCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        accessCalls++;
        return mockCapabilitiesResponse({
          householdsEnabled: false,
          canView: true,
          canReadMinors: true,
        });
      }
      if (path === "/v1/households/list") {
        listCalls++;
        return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() => expect(accessCalls).toBeGreaterThanOrEqual(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(screen.getByText("Not allowed")).toBeTruthy();
    expect(screen.queryByText("Loading households...")).toBeNull();
    expect(screen.queryByText("No households yet")).toBeNull();
    expect(listCalls).toBe(0);
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("shows Not allowed and makes no list call when caller lacks people.view", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let accessCalls = 0;
    let listCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        accessCalls++;
        return mockCapabilitiesResponse({
          householdsEnabled: true,
          canView: false,
          canReadMinors: true,
        });
      }
      if (path === "/v1/households/list") {
        listCalls++;
        return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() => expect(accessCalls).toBeGreaterThanOrEqual(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(screen.getByText("Not allowed")).toBeTruthy();
    expect(screen.queryByText("Loading households...")).toBeNull();
    expect(screen.queryByText("No households yet")).toBeNull();
    expect(listCalls).toBe(0);
  });
});

describe("Family Records list view", () => {
  it("renders empty state ('No households yet') and passes axe", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: true },
      listResult: { items: [], nextCursor: null },
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("No households yet")).toBeTruthy();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("renders household list with label, adultCount, and View button, and passes axe", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const householdItem = {
      householdId: "00000000-0000-4000-8000-000000000001",
      version: 1,
      label: "Smith Household",
      adultCount: 2,
    };
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: true },
      listResult: { items: [householdItem], nextCursor: null },
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Smith Household")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View Smith Household" })).toBeTruthy();

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("renders — for household label when label is null for caller without people.restricted.read", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const householdItem = {
      householdId: "00000000-0000-4000-8000-000000000002",
      version: 1,
      label: null,
      adultCount: 1,
    };
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: false },
      listResult: { items: [householdItem], nextCursor: null },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("—")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View household" })).toBeTruthy();
  });

  it("renders None for household label when label is null for caller with people.restricted.read", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const householdItem = {
      householdId: "00000000-0000-4000-8000-000000000002",
      version: 1,
      label: null,
      adultCount: 1,
    };
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: true },
      listResult: { items: [householdItem], nextCursor: null },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const noneEl = await screen.findByText("None");
    expect(noneEl).toBeTruthy();
    expect(noneEl.closest("td")?.getAttribute("data-label")).toBe("Household");
    expect(noneEl.className).toContain("text-muted-foreground");
    expect(document.querySelector('[data-slot="restricted-value"]')).toBeNull();
  });

  it("renders RestrictedValue in the Household cell for caller without people.restricted.read when label is null (Pin 28)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const householdItem = {
      householdId: "00000000-0000-4000-8000-000000000002",
      version: 1,
      label: null,
      adultCount: 1,
    };
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: false },
      listResult: { items: [householdItem], nextCursor: null },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await screen.findByText("—");
    const restricted = document.querySelector('[data-slot="restricted-value"]');
    expect(restricted).not.toBeNull();
    expect(restricted?.getAttribute("title")).toBe("Hidden for your role");
    expect(restricted?.textContent).toContain("Household name hidden for your role");
    const householdCell = restricted?.closest("td");
    expect(householdCell?.getAttribute("data-label")).toBe("Household");
    expect(within(householdCell!).queryByText("None")).toBeNull();
  });

  describe("Pin 29: new line alert visibility in both directions", () => {
    const HIDDEN_NOTICE = "Household names and children are hidden for your role.";

    it("shows the new line alert without people.restricted.read across list, empty, pending, and error states (Pin 29)", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);

      // State 1: pending list request
      let resolveList: ((res: Response) => void) | undefined;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({
            householdsEnabled: true,
            canView: true,
            canReadMinors: false,
          });
        }
        if (path === "/v1/billing/status") {
          return new Response(
            JSON.stringify({
              state: "ok",
              trial_end: null,
              grace_until: null,
              canView: true,
              canManage: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (path === "/v1/households/list") {
          return new Promise<Response>((resolve) => {
            resolveList = resolve;
          });
        }
        return new Response(null, { status: 404 });
      });

      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      // Pending state
      await waitFor(() => {
        expect(resolveList).toBeDefined();
      });
      const pendingNotice = screen.getByText(HIDDEN_NOTICE);
      expect(pendingNotice).toBeTruthy();
      expect(
        pendingNotice.getAttribute("role") ??
          pendingNotice.closest('[role="status"]')?.getAttribute("role"),
      ).toBe("status");

      // Resolve with households list (State 2: with list)
      resolveList!(
        new Response(
          JSON.stringify({
            items: [
              {
                householdId: "00000000-0000-4000-8000-000000000001",
                version: 1,
                label: null,
                adultCount: 1,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      expect(await screen.findByText("—")).toBeTruthy();
      const listNotice = screen.getByText(HIDDEN_NOTICE);
      expect(listNotice).toBeTruthy();
      expect(
        listNotice.getAttribute("role") ??
          listNotice.closest('[role="status"]')?.getAttribute("role"),
      ).toBe("status");

      cleanup();

      // State 3: empty list (beside "No households yet")
      mockApi({
        access: { householdsEnabled: true, canView: true, canReadMinors: false },
        listResult: { items: [], nextCursor: null },
      });
      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("No households yet")).toBeTruthy();
      const emptyNotice = screen.getByText(HIDDEN_NOTICE);
      expect(emptyNotice).toBeTruthy();
      expect(
        emptyNotice.getAttribute("role") ??
          emptyNotice.closest('[role="status"]')?.getAttribute("role"),
      ).toBe("status");

      cleanup();

      // State 4: failed load error
      mockApi({
        access: { householdsEnabled: true, canView: true, canReadMinors: false },
        listResult: 500,
      });
      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("Failed to load households")).toBeTruthy();
      const errorNotice = screen.getByText(HIDDEN_NOTICE);
      expect(errorNotice).toBeTruthy();
      expect(
        errorNotice.getAttribute("role") ??
          errorNotice.closest('[role="status"]')?.getAttribute("role"),
      ).toBe("status");
    });

    it("does not show the new line alert with people.restricted.read across list, empty, pending, and error states, and not when Not allowed (Pin 29)", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);

      // State 1: pending list request
      let resolveList: ((res: Response) => void) | undefined;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({
            householdsEnabled: true,
            canView: true,
            canReadMinors: true,
          });
        }
        if (path === "/v1/billing/status") {
          return new Response(
            JSON.stringify({
              state: "ok",
              trial_end: null,
              grace_until: null,
              canView: true,
              canManage: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (path === "/v1/households/list") {
          return new Promise<Response>((resolve) => {
            resolveList = resolve;
          });
        }
        return new Response(null, { status: 404 });
      });

      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      await waitFor(() => {
        expect(resolveList).toBeDefined();
        expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
      });
      expect(screen.queryByText(HIDDEN_NOTICE)).toBeNull();

      // Resolve with households list (State 2: with list)
      resolveList!(
        new Response(
          JSON.stringify({
            items: [
              {
                householdId: "00000000-0000-4000-8000-000000000001",
                version: 1,
                label: "Harrow Family",
                adultCount: 2,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      expect(await screen.findByText("Harrow Family")).toBeTruthy();
      expect(screen.queryByText(HIDDEN_NOTICE)).toBeNull();

      cleanup();

      // State 3: empty list (beside "No households yet")
      mockApi({
        access: { householdsEnabled: true, canView: true, canReadMinors: true },
        listResult: { items: [], nextCursor: null },
      });
      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("No households yet")).toBeTruthy();
      expect(screen.queryByText(HIDDEN_NOTICE)).toBeNull();

      cleanup();

      // State 4: failed load error
      mockApi({
        access: { householdsEnabled: true, canView: true, canReadMinors: true },
        listResult: 500,
      });
      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("Failed to load households")).toBeTruthy();
      expect(screen.queryByText(HIDDEN_NOTICE)).toBeNull();

      cleanup();

      // State 5: Not allowed (access gate failure)
      mockApi({
        access: { householdsEnabled: false, canView: true, canReadMinors: false },
      });
      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("Not allowed")).toBeTruthy();
      expect(screen.queryByText(HIDDEN_NOTICE)).toBeNull();
    });
  });

  it("defensively reveals no minor data on list when caller lacks people.restricted.read", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const householdItem = {
      householdId: "00000000-0000-4000-8000-000000000002",
      version: 1,
      label: null,
      adultCount: 1,
      minors: [{ givenName: "Pip", familyName: "Tolland", dateOfBirth: "2016-03-14" }],
      minorCount: 1,
    };
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: false },
      listResult: { items: [householdItem], nextCursor: null },
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("—")).toBeTruthy();
    const html = container.innerHTML;
    expect(html).not.toContain("Pip");
    expect(html).not.toContain("Tolland");
    expect(html).not.toContain("2016");
    expect(/minor/i.test(html)).toBe(false);
    const restricted = container.querySelector('[data-slot="restricted-value"]');
    expect(restricted).not.toBeNull();
    expect(restricted?.closest("td")?.getAttribute("data-label")).toBe("Household");
  });

  it("shows skeleton with aria-hidden and Loading households in a plain sr-only span with no role or aria-live while loading", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let resolvePending: ((res: Response) => void) | undefined;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({
          householdsEnabled: true,
          canView: true,
          canReadMinors: true,
        });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/households/list") {
        return new Promise<Response>((resolve) => {
          resolvePending = resolve;
        });
      }
      return new Response(null, { status: 404 });
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const skeleton = await waitFor(() => {
      const el = document.querySelector('[data-slot="skeleton"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(skeleton.getAttribute("aria-hidden")).toBe("true");

    const loadingText = screen.getByText("Loading households...");
    expect(loadingText.tagName.toLowerCase()).toBe("span");
    expect(loadingText.classList.contains("sr-only")).toBe(true);
    expect(loadingText.getAttribute("role")).toBeNull();
    expect(loadingText.getAttribute("aria-live")).toBeNull();

    resolvePending?.(
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("sets data-label on every table cell matching column headers and none equals household label", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const householdItem = {
      householdId: "00000000-0000-4000-8000-000000000001",
      version: 1,
      label: "Vance Household",
      adultCount: 3,
    };
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: true },
      listResult: { items: [householdItem], nextCursor: null },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Vance Household")).toBeTruthy();
    const cells = Array.from(document.querySelectorAll("table[aria-label='Households'] tbody td"));
    expect(cells.length).toBe(4);
    const allowedLabels = new Set(["Household", "Adults", "Status", "Actions"]);
    for (const cell of cells) {
      const dataLabel = cell.getAttribute("data-label");
      expect(allowedLabels.has(dataLabel ?? "")).toBe(true);
      expect(dataLabel).not.toBe(householdItem.label);
    }
  });

  it("handles keyset pagination with limit 25 and cursor", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const page1Item = {
      householdId: "00000000-0000-4000-8000-000000000001",
      version: 1,
      label: "Household Alpha",
      adultCount: 2,
    };
    const page2Item = {
      householdId: "00000000-0000-4000-8000-000000000002",
      version: 1,
      label: "Household Beta",
      adultCount: 1,
    };

    const recordedBodies: Array<{ limit?: number; cursor?: string; communitySlug?: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({
          householdsEnabled: true,
          canView: true,
          canReadMinors: true,
        });
      }
      if (path === "/v1/households/list") {
        const body = JSON.parse(String(init?.body)) as {
          limit?: number;
          cursor?: string;
          communitySlug?: string;
        };
        recordedBodies.push(body);
        if (body.cursor === "cursor-token-1") {
          return new Response(JSON.stringify({ items: [page2Item], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ items: [page1Item], nextCursor: "cursor-token-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Household Alpha")).toBeTruthy();
    expect(recordedBodies[0]?.limit).toBe(25);

    const nextBtn = screen.getByRole("button", { name: "Next page" });
    fireEvent.click(nextBtn);

    expect(await screen.findByText("Household Beta")).toBeTruthy();
    expect(recordedBodies[1]?.cursor).toBe("cursor-token-1");
    expect(recordedBodies[1]?.limit).toBe(25);
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it.each([402, 403, 404, 409, 429, 503])(
    "shows the retryable load error and no rows on a %i household list (finding H5c)",
    async (status) => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      // A VALID list body on a non-200 status: only the status check can reject it.
      const spy = mockApi({
        access: { householdsEnabled: true, canView: true, canReadMinors: true },
        listResult: {
          items: [
            {
              householdId: "00000000-0000-4000-8000-000000000001",
              version: 1,
              label: "Should Not Render",
              adultCount: 1,
            },
          ],
          nextCursor: null,
        },
      });
      const real = spy.getMockImplementation()!;
      spy.mockImplementation(async (info, init) => {
        const res = await real(info, init);
        return String(info).endsWith("/v1/households/list")
          ? new Response(await res.text(), { status })
          : res;
      });

      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("Failed to load households")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(screen.queryByText("No households yet")).toBeNull();
      expect(screen.queryByText("Should Not Render")).toBeNull();
    },
  );

  it("shows error alert and retry button on fetch failure, clicking retry refetches", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({
          householdsEnabled: true,
          canView: true,
          canReadMinors: true,
        });
      }
      if (path === "/v1/households/list") {
        attempts++;
        if (attempts === 1) {
          return new Response(null, { status: 500 });
        }
        return new Response(
          JSON.stringify({
            items: [
              {
                householdId: "00000000-0000-4000-8000-000000000001",
                version: 1,
                label: "Recovered Household",
                adultCount: 1,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Failed to load households")).toBeTruthy();
    const retryBtn = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retryBtn);

    expect(await screen.findByText("Recovered Household")).toBeTruthy();
    expect(attempts).toBe(2);
  });
});

describe("Family Records detail view", () => {
  const sampleDetail = {
    householdId: "00000000-0000-4000-8000-000000000001",
    version: 1,
    label: "Clarke Family",
    adults: [
      {
        personId: "00000000-0000-4000-8000-000000000010",
        givenName: "Arthur",
        familyName: "Clarke",
        version: 1,
      },
    ],
    minors: [
      {
        personId: "00000000-0000-4000-8000-000000000020",
        givenName: "Leo",
        familyName: "Clarke",
        dateOfBirth: "2015-06-12",
        version: 1,
      },
    ],
    guardians: [
      {
        linkId: "00000000-0000-4000-8000-000000000030",
        guardianId: "00000000-0000-4000-8000-000000000010",
        childId: "00000000-0000-4000-8000-000000000020",
        rights: {
          consent: true,
          pickup: true,
          view: true,
          manage: false,
        },
      },
    ],
  };

  it("clicking View loads detail and displays adult members, and passes axe", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(await screen.findByText("Clarke Family")).toBeTruthy();
    expect(screen.getByText("Arthur")).toBeTruthy();
    expect(screen.getAllByText("Clarke").length).toBeGreaterThanOrEqual(1);

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("renders generic 'Household not found' on 404 response without leaking and passes axe", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: "00000000-0000-4000-8000-000000000099",
            version: 1,
            label: "Unknown",
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: 404,
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Unknown" });
    fireEvent.click(viewBtn);

    expect(await screen.findByText("Household not found")).toBeTruthy();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("shows 'Failed to load household' and Retry button on read error, clicking retry refetches", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let readAttempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({
          householdsEnabled: true,
          canView: true,
          canReadMinors: true,
        });
      }
      if (path === "/v1/households/list") {
        return new Response(
          JSON.stringify({
            items: [
              {
                householdId: sampleDetail.householdId,
                version: 1,
                label: sampleDetail.label,
                adultCount: 1,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/households/read") {
        readAttempts++;
        if (readAttempts === 1) {
          return new Response(null, { status: 500 });
        }
        return new Response(JSON.stringify(sampleDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByText("Failed to load household")).toBeTruthy();
    const retryBtn = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retryBtn);

    expect(await screen.findByText("Arthur")).toBeTruthy();
    expect(readAttempts).toBe(2);
  });

  it.each([402, 403, 409, 429, 503])(
    "shows the retryable load error, not 'Household not found', on a %i household read (finding H5c)",
    async (status) => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      // A VALID detail body on a non-200 status: only the status check can reject it.
      const spy = mockApi({
        access: { householdsEnabled: true, canView: true, canReadMinors: true },
        listResult: {
          items: [
            {
              householdId: sampleDetail.householdId,
              version: 1,
              label: sampleDetail.label,
              adultCount: 1,
            },
          ],
          nextCursor: null,
        },
        detailResult: sampleDetail,
      });
      const real = spy.getMockImplementation()!;
      spy.mockImplementation(async (info, init) => {
        const res = await real(info, init);
        return String(info).endsWith("/v1/households/read")
          ? new Response(await res.text(), { status })
          : res;
      });

      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));
      fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));

      expect(await screen.findByText("Failed to load household")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(screen.queryByText("Household not found")).toBeNull();
      expect(screen.queryByText("Arthur")).toBeNull();
    },
  );

  it("Back to list button navigates back to list view", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    const backBtn = screen.getByRole("button", { name: "Back to list" });
    fireEvent.click(backBtn);

    expect(await screen.findByRole("heading", { name: "Family Records", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Household Details" })).toBeNull();
  });

  it("shows minors section with DOB and guardians section when caller has people.restricted.read (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Minors" })).toBeTruthy();
    expect(screen.getByText("Leo")).toBeTruthy();
    expect(screen.getByText("2015-06-12")).toBeTruthy();

    expect(screen.getByRole("heading", { name: "Guardians" })).toBeTruthy();
    expect(screen.getByText("Consent, Pickup, View")).toBeTruthy();

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("hides minors section and guardian links when caller lacks people.restricted.read (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    // Detail response from server without minors or with minors stripped
    const unrestrictedDetail = {
      householdId: sampleDetail.householdId,
      version: 1,
      label: null,
      adults: sampleDetail.adults,
      guardians: [],
    };
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: false },
      listResult: {
        items: [{ householdId: sampleDetail.householdId, version: 1, label: null, adultCount: 1 }],
        nextCursor: null,
      },
      detailResult: unrestrictedDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View household" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(await screen.findByText("Arthur")).toBeTruthy();

    // Minors section and guardians section MUST NOT be rendered
    expect(screen.queryByRole("heading", { name: "Minors" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Guardians" })).toBeNull();
    expect(screen.queryByText("Leo")).toBeNull();
    expect(screen.queryByText("2015-06-12")).toBeNull();
  });

  it("defensively omits minors section when caller lacks people.restricted.read even if server payload contains minors (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    // Erroneous server payload containing minors to an unrestricted caller
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: false },
      listResult: {
        items: [{ householdId: sampleDetail.householdId, version: 1, label: null, adultCount: 1 }],
        nextCursor: null,
      },
      detailResult: sampleDetail, // contains minors!
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View household" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(await screen.findByText("Arthur")).toBeTruthy();

    // Pin 21: UI MUST NOT render minors section without people.restricted.read
    expect(screen.queryByRole("heading", { name: "Minors" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Guardians" })).toBeNull();
    expect(screen.queryByText("Leo")).toBeNull();
  });

  it("discards an in-flight detail read after community switch so the prior household never appears", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const householdA = {
      householdId: "00000000-0000-4000-8000-0000000000aa",
      version: 1,
      label: "Stale Household",
      adults: [
        {
          personId: "00000000-0000-4000-8000-0000000000a1",
          givenName: "Stale",
          familyName: "Adult",
          version: 1,
        },
      ],
      guardians: [],
    };
    const householdB = {
      householdId: "00000000-0000-4000-8000-0000000000bb",
      version: 1,
      label: "Fresh Household",
      adults: [
        {
          personId: "00000000-0000-4000-8000-0000000000b1",
          givenName: "Fresh",
          familyName: "Adult",
          version: 1,
        },
      ],
      guardians: [],
    };
    let resolveStaleRead: ((value: Response) => void) | undefined;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({
          householdsEnabled: true,
          canView: true,
          canManage: true,
          canReadMinors: true,
        });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200 },
        );
      }
      if (path === "/v1/households/list") {
        if (body.communitySlug === "community-b") {
          return new Response(
            JSON.stringify({
              items: [
                {
                  householdId: householdB.householdId,
                  version: 1,
                  label: householdB.label,
                  adultCount: 1,
                },
              ],
              nextCursor: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            items: [
              {
                householdId: householdA.householdId,
                version: 1,
                label: householdA.label,
                adultCount: 1,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/households/read") {
        if (body.householdId === householdA.householdId) {
          return new Promise<Response>((resolve) => {
            resolveStaleRead = resolve;
          });
        }
        return new Response(JSON.stringify(householdB), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showFamilyRecords();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    fireEvent.click(await screen.findByRole("button", { name: "View Stale Household" }));
    expect(await screen.findByText("Loading household details...")).toBeTruthy();

    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);
    expect(await screen.findByRole("button", { name: "View Fresh Household" })).toBeTruthy();

    resolveStaleRead?.(
      new Response(JSON.stringify(householdA), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await act(async () => {});

    expect(screen.queryByText("Stale Household")).toBeNull();
    expect(screen.queryByText("Stale")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Household Details" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View Fresh Household" }));
    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(await screen.findByText("Fresh Household")).toBeTruthy();
    expect(screen.queryByText("Stale Household")).toBeNull();
    expect(screen.getByText("Fresh")).toBeTruthy();
  });
});

describe("Family Records Actions - Capabilities & Controls Gating (Pin 21)", () => {
  const sampleDetail = {
    householdId: "00000000-0000-4000-8000-000000000001",
    version: 1,
    label: "Clarke Family",
    adults: [
      {
        personId: "00000000-0000-4000-8000-000000000010",
        givenName: "Arthur",
        familyName: "Clarke",
        version: 1,
      },
    ],
    minors: [
      {
        personId: "00000000-0000-4000-8000-000000000020",
        givenName: "Leo",
        familyName: "Clarke",
        dateOfBirth: "2015-06-12",
        version: 1,
      },
    ],
    guardians: [
      {
        linkId: "00000000-0000-4000-8000-000000000030",
        guardianId: "00000000-0000-4000-8000-000000000010",
        childId: "00000000-0000-4000-8000-000000000020",
        rights: { consent: true, pickup: true, view: true, manage: false },
      },
    ],
  };

  it("Pin 16: hides life events panel and sends no request without people.restricted.read", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const postCalls: string[] = [];
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: false },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      onPost: (path) => postCalls.push(path),
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(await screen.findByText("Arthur")).toBeTruthy();

    expect(screen.queryByText(/Life events: Arthur Clarke/i)).toBeNull();
    expect(screen.queryByText("No life events recorded")).toBeNull();
    expect(postCalls.filter((p) => p.includes("/v1/people/life-events"))).toHaveLength(0);
  });

  it("Pin 16: hides life events panel and sends no request without people.households", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    sessionStorage.setItem("community-hub.community", SLUG);
    const postCalls: string[] = [];
    mockApi({
      access: { householdsEnabled: false, canView: true, canManage: true, canReadMinors: true },
      onPost: (path) => postCalls.push(path),
    });

    render(
      <CommunityProvider>
        <MinorsSection
          detailHousehold={sampleDetail}
          access={{
            entitlements: {
              "people.directory": true,
              "people.households": false,
              "module.engagement": false,
            },
            permissions: {
              "people.view": true,
              "people.manage": true,
              "people.restricted.read": true,
              "people.delete": false,
              "service_times.manage": false,
            },
          }}
          isReadOnly={false}
        />
      </CommunityProvider>,
    );

    expect(screen.queryByText(/Life events: Leo Clarke/i)).toBeNull();
    expect(screen.queryByText("No life events recorded")).toBeNull();
    expect(postCalls.filter((p) => p.includes("/v1/people/life-events"))).toHaveLength(0);
  });

  it("Pin 9: hides life events panel and sends no request without people.restricted.read in MinorsSection", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    sessionStorage.setItem("community-hub.community", SLUG);
    const postCalls: string[] = [];
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: false },
      onPost: (path) => postCalls.push(path),
    });

    render(
      <CommunityProvider>
        <MinorsSection
          detailHousehold={sampleDetail}
          access={{
            entitlements: {
              "people.directory": true,
              "people.households": true,
              "module.engagement": false,
            },
            permissions: {
              "people.view": true,
              "people.manage": true,
              "people.restricted.read": false,
              "people.delete": false,
              "service_times.manage": false,
            },
          }}
          isReadOnly={false}
        />
      </CommunityProvider>,
    );

    expect(screen.queryByText(/Life events: Leo Clarke/i)).toBeNull();
    expect(screen.queryByText("No life events recorded")).toBeNull();
    expect(postCalls.filter((p) => p.includes("/v1/people/life-events"))).toHaveLength(0);
  });

  it("Pin 19: hides 'Unlink' button in MinorsSection when isReadOnly is true", () => {
    render(
      <CommunityProvider>
        <MinorsSection
          detailHousehold={sampleDetail}
          access={{
            entitlements: {
              "people.directory": true,
              "people.households": true,
              "module.engagement": false,
            },
            permissions: {
              "people.view": true,
              "people.manage": true,
              "people.restricted.read": true,
              "people.delete": false,
              "service_times.manage": false,
            },
          }}
          isReadOnly={true}
        />
      </CommunityProvider>,
    );

    expect(
      screen.queryByRole("button", { name: "Unlink Arthur Clarke from Leo Clarke" }),
    ).toBeNull();
  });

  it("Pin 16: renders life events panel for adult and minor members when holding both capabilities", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const postCalls: { path: string; body: unknown }[] = [];
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      onPost: (path, body) => postCalls.push({ path, body }),
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(await screen.findByText("Arthur")).toBeTruthy();
    expect(screen.getByText("Leo")).toBeTruthy();

    expect(await screen.findByText(/Life events: Arthur Clarke/i)).toBeTruthy();
    expect(await screen.findByText(/Life events: Leo Clarke/i)).toBeTruthy();

    const adultPersonId = sampleDetail.adults[0]?.personId;
    const minorPersonId = sampleDetail.minors[0]?.personId;
    await waitFor(() => {
      const lifeEventCalls = postCalls.filter((p) => p.path === "/v1/people/life-events/list");
      expect(lifeEventCalls).toHaveLength(2);
      expect(
        lifeEventCalls.some(
          (c) =>
            typeof c.body === "object" &&
            c.body !== null &&
            "personId" in c.body &&
            (c.body as { personId: string }).personId === adultPersonId,
        ),
      ).toBe(true);
      expect(
        lifeEventCalls.some(
          (c) =>
            typeof c.body === "object" &&
            c.body !== null &&
            "personId" in c.body &&
            (c.body as { personId: string }).personId === minorPersonId,
        ),
      ).toBe(true);
    });
  });

  it("hides life event Add and Edit buttons while billing is loading or read-only, and displays them when ready and writable", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);

    let resolveBilling!: (res: Response) => void;
    const billingPromise = new Promise<Response>((resolve) => {
      resolveBilling = resolve;
    });

    const sampleEvent = {
      eventId: "00000000-0000-4000-8000-000000000001",
      version: 1,
      type: "baptism",
      date: "2010-04-15",
      place: "St Stephen Parish",
      notes: "Godparents present",
    };

    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      billingStatus: billingPromise,
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      lifeEventsListResult: { items: [sampleEvent] },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(await screen.findByText(/Life events: Arthur Clarke/i)).toBeTruthy();
    expect(await screen.findByText(/Life events: Leo Clarke/i)).toBeTruthy();

    // While billing status is loading: no Add or Edit button in adult or minor panel
    expect(screen.queryAllByRole("button", { name: "Add life event" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /Edit/i })).toHaveLength(0);

    // Settle billing status as ready and writable
    await act(async () => {
      resolveBilling(
        new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });

    // Once billing is ready and writable: Add and Edit buttons render for both adult and minor
    const addButtons = await screen.findAllByRole("button", { name: "Add life event" });
    expect(addButtons).toHaveLength(2);
    const editButtons = await screen.findAllByRole("button", { name: /Edit/i });
    expect(editButtons).toHaveLength(2);

    cleanup();

    // Now verify while read-only: no Add or Edit button renders
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      billingStatus: { state: "read_only", canView: true, canManage: false },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      lifeEventsListResult: { items: [sampleEvent] },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtnReadOnly = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtnReadOnly);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(await screen.findByText(/Life events: Arthur Clarke/i)).toBeTruthy();
    expect(await screen.findByText(/Life events: Leo Clarke/i)).toBeTruthy();

    expect(screen.queryAllByRole("button", { name: "Add life event" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /Edit/i })).toHaveLength(0);
  });

  it("hides 'Create household' button when caller lacks people.manage (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: false, canReadMinors: true },
      listResult: { items: [], nextCursor: null },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("No households yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create household" })).toBeNull();
  });

  it("shows 'Create household' button when caller has people.manage (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: false },
      listResult: { items: [], nextCursor: null },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByRole("button", { name: "Create household" })).toBeTruthy();
  });

  it("hides 'Rename household' button when caller lacks people.manage (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: false, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename household" })).toBeNull();
  });

  it("hides 'Rename household' button when caller lacks people.restricted.read", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: false },
      listResult: {
        items: [
          { householdId: sampleDetail.householdId, version: 1, label: "Clarke", adultCount: 1 },
        ],
        nextCursor: null,
      },
      detailResult: { ...sampleDetail, label: "Clarke" },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename household" })).toBeNull();
  });

  it("shows 'Rename household' button when caller has people.manage and people.restricted.read", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          { householdId: sampleDetail.householdId, version: 1, label: "Clarke", adultCount: 1 },
        ],
        nextCursor: null,
      },
      detailResult: { ...sampleDetail, label: "Clarke" },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("button", { name: "Rename household" })).toBeTruthy();
  });

  it("hides 'Move adult' button when caller lacks people.manage (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: false, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Move Arthur Clarke|Move adult/i })).toBeNull();
  });

  it("hides 'Move adult' button when caller lacks people.restricted.read (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: false },
      listResult: {
        items: [{ householdId: sampleDetail.householdId, version: 1, label: null, adultCount: 1 }],
        nextCursor: null,
      },
      detailResult: { ...sampleDetail, label: null, minors: undefined, guardians: [] },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View household" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Move Arthur Clarke|Move adult/i })).toBeNull();
  });

  it("shows 'Move adult' button when caller has both people.manage and people.restricted.read (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("button", { name: "Move Arthur Clarke" })).toBeTruthy();
  });

  it("hides 'Add adult' when caller lacks people.manage", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: false, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add adult" })).toBeNull();
  });

  it("hides 'Add adult' when caller lacks people.restricted.read", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: false },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: { ...sampleDetail, minors: undefined, guardians: [] },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add adult" })).toBeNull();
  });

  it("hides 'Add adult' when people.directory entitlement is off", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: {
        householdsEnabled: true,
        directoryEnabled: false,
        canView: true,
        canManage: true,
        canReadMinors: true,
      },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add adult" })).toBeNull();
  });

  it("shows 'Add adult' when manage, restricted.read and directory are held, including empty households", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const emptyHousehold = {
      ...sampleDetail,
      adults: [] as typeof sampleDetail.adults,
      minors: undefined,
      guardians: [],
    };
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: emptyHousehold.householdId,
            version: 1,
            label: emptyHousehold.label,
            adultCount: 0,
          },
        ],
        nextCursor: null,
      },
      detailResult: emptyHousehold,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    expect(await screen.findByText("No adult members")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Add adult" })).toBeTruthy();
  });

  it("searches adults, omits household members, adds with version, and reloads detail", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const recordedCalls: Array<{ path: string; body: unknown }> = [];
    let detailLoads = 0;
    const otherAdult = {
      id: "00000000-0000-4000-8000-000000000011",
      personId: "00000000-0000-4000-8000-000000000011",
      isMinor: false,
      givenName: "Isaac",
      familyName: "Asimov",
      version: 4,
    };
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      peopleListResult: {
        items: [
          {
            id: sampleDetail.adults[0]!.personId,
            personId: sampleDetail.adults[0]!.personId,
            isMinor: false,
            givenName: "Arthur",
            familyName: "Clarke",
            version: 1,
          },
          otherAdult,
        ],
        nextCursor: "more-results-token",
      },
      moveAdultResult: { version: 5 },
      onPost: (path, body) => recordedCalls.push({ path, body }),
    });

    // Override detail to count reloads after add
    const fetchSpy = vi.mocked(globalThis.fetch);
    const originalImpl = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/households/read") {
        detailLoads++;
        return new Response(
          JSON.stringify(
            detailLoads > 1
              ? {
                  ...sampleDetail,
                  adults: [
                    ...sampleDetail.adults,
                    {
                      personId: otherAdult.personId,
                      givenName: otherAdult.givenName,
                      familyName: otherAdult.familyName,
                      version: 5,
                    },
                  ],
                }
              : sampleDetail,
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalImpl(info, init);
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add adult" }));

    expect(await screen.findByRole("heading", { name: "Add Adult" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search adults" }), {
      target: { value: "Asimov" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Isaac")).toBeTruthy();
    expect(screen.queryByText("Arthur")).toBeNull();
    expect(screen.getByText("More results exist. Refine your search.")).toBeTruthy();

    const listCall = recordedCalls.find((c) => c.path === "/v1/people/list");
    expect(listCall).toEqual({
      path: "/v1/people/list",
      body: { communitySlug: SLUG, kind: "adults", search: "Asimov" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Isaac Asimov to household" }));

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(await screen.findByText("Isaac")).toBeTruthy();
    const moveCall = recordedCalls.find((c) => c.path === "/v1/households/members/move-adult");
    expect(moveCall).toEqual({
      path: "/v1/households/members/move-adult",
      body: {
        communitySlug: SLUG,
        householdId: sampleDetail.householdId,
        personId: otherAdult.personId,
        version: 4,
      },
    });
  });

  it("shows a 409 alert on add adult, clears results, and clears search on community switch", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const otherAdult = {
      id: "00000000-0000-4000-8000-000000000011",
      personId: "00000000-0000-4000-8000-000000000011",
      isMinor: false,
      givenName: "Isaac",
      familyName: "Asimov",
      version: 4,
    };
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      peopleListResult: { items: [otherAdult], nextCursor: null },
      moveAdultResult: 409,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add adult" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search adults" }), {
      target: { value: "Isaac" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Isaac")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add Isaac Asimov to household" }));
    expect(
      await screen.findByText(
        "This change could not be applied. The adult may have guardian links, or they changed. Search again to see the latest.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Isaac")).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: "other-community" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(screen.queryByRole("heading", { name: "Add Adult" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Search adults" })).toBeNull();
  });

  it("shows No adults found when search returns none", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      peopleListResult: { items: [], nextCursor: null },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add adult" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search adults" }), {
      target: { value: "Nobody" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("No adults found")).toBeTruthy();
  });

  it("omits search from the people list body when the box is empty or whitespace-only", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const recordedCalls: Array<{ path: string; body: unknown }> = [];
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      peopleListResult: { items: [], nextCursor: null },
      onPost: (path, body) => recordedCalls.push({ path, body }),
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add adult" }));

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("No adults found");

    const emptyCall = recordedCalls.find((c) => c.path === "/v1/people/list");
    expect(emptyCall).toEqual({
      path: "/v1/people/list",
      body: { communitySlug: SLUG, kind: "adults" },
    });

    recordedCalls.length = 0;
    fireEvent.change(screen.getByRole("textbox", { name: "Search adults" }), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("No adults found");

    const whitespaceCall = recordedCalls.find((c) => c.path === "/v1/people/list");
    expect(whitespaceCall).toEqual({
      path: "/v1/people/list",
      body: { communitySlug: SLUG, kind: "adults" },
    });
  });

  it("hides 'Add minor' button when caller lacks people.manage (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: false, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Minors" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add minor" })).toBeNull();
  });

  it("hides 'Add minor' button when caller lacks people.restricted.read (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: false },
      listResult: {
        items: [{ householdId: sampleDetail.householdId, version: 1, label: null, adultCount: 1 }],
        nextCursor: null,
      },
      detailResult: { ...sampleDetail, label: null, minors: undefined, guardians: [] },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View household" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add minor" })).toBeNull();
  });

  it("shows 'Add minor' button when caller has both people.manage and people.restricted.read (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("button", { name: "Add minor" })).toBeTruthy();
  });

  it("hides 'Link guardian' button when caller lacks people.manage (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: false, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Guardians" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link guardian" })).toBeNull();
  });

  it("hides 'Link guardian' button when caller lacks people.restricted.read (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: false },
      listResult: {
        items: [{ householdId: sampleDetail.householdId, version: 1, label: null, adultCount: 1 }],
        nextCursor: null,
      },
      detailResult: { ...sampleDetail, label: null, minors: undefined, guardians: [] },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View household" });
    fireEvent.click(viewBtn);

    expect(screen.queryByRole("button", { name: "Link guardian" })).toBeNull();
  });

  it("shows 'Link guardian' button when caller has both people.manage and people.restricted.read (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("button", { name: "Link guardian" })).toBeTruthy();
  });

  it("hides 'Unlink' button when caller lacks people.manage (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: false, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Guardians" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Unlink/i })).toBeNull();
  });

  it("hides 'Unlink' button when caller lacks people.restricted.read (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: false },
      listResult: {
        items: [{ householdId: sampleDetail.householdId, version: 1, label: null, adultCount: 1 }],
        nextCursor: null,
      },
      detailResult: { ...sampleDetail, label: null, minors: undefined, guardians: [] },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View household" });
    fireEvent.click(viewBtn);

    expect(screen.queryByRole("button", { name: /Unlink/i })).toBeNull();
  });

  it("shows 'Unlink' button when caller has both people.manage and people.restricted.read (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(
      await screen.findByRole("button", { name: "Unlink Arthur Clarke from Leo Clarke" }),
    ).toBeTruthy();
  });

  it("independently hides 'Add minor' button in MinorsSection when caller lacks people.restricted.read", () => {
    render(
      <MinorsSection
        detailHousehold={sampleDetail}
        access={{
          permissions: {
            "people.view": true,
            "people.manage": true,
            "people.restricted.read": false,
            "people.delete": false,
            "service_times.manage": false,
          },
          entitlements: {
            "people.directory": true,
            "people.households": true,
            "module.engagement": false,
          },
        }}
        isReadOnly={false}
      />,
    );
    expect(screen.getByRole("heading", { name: "Minors" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add minor" })).toBeNull();
  });

  it("independently hides 'Link guardian' button in MinorsSection when caller lacks people.restricted.read", () => {
    render(
      <MinorsSection
        detailHousehold={sampleDetail}
        access={{
          permissions: {
            "people.view": true,
            "people.manage": true,
            "people.restricted.read": false,
            "people.delete": false,
            "service_times.manage": false,
          },
          entitlements: {
            "people.directory": true,
            "people.households": true,
            "module.engagement": false,
          },
        }}
        isReadOnly={false}
      />,
    );
    expect(screen.getByRole("heading", { name: "Guardians" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link guardian" })).toBeNull();
  });

  it("independently hides 'Unlink' button in MinorsSection when caller lacks people.restricted.read", () => {
    render(
      <MinorsSection
        detailHousehold={sampleDetail}
        access={{
          permissions: {
            "people.view": true,
            "people.manage": true,
            "people.restricted.read": false,
            "people.delete": false,
            "service_times.manage": false,
          },
          entitlements: {
            "people.directory": true,
            "people.households": true,
            "module.engagement": false,
          },
        }}
        isReadOnly={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Unlink Arthur Clarke from Leo Clarke" }),
    ).toBeNull();
  });

  it("independently gates Add minor, Link guardian and Unlink on people.manage in MinorsSection (finding H5b)", () => {
    // Positive control: manage and restricted.read both held shows all three controls.
    const { unmount } = render(
      <MinorsSection
        detailHousehold={sampleDetail}
        access={{
          permissions: {
            "people.view": true,
            "people.manage": true,
            "people.restricted.read": true,
            "people.delete": false,
            "service_times.manage": false,
          },
          entitlements: {
            "people.directory": true,
            "people.households": true,
            "module.engagement": false,
          },
        }}
        isReadOnly={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Add minor" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link guardian" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Unlink/i }).length).toBeGreaterThan(0);
    unmount();

    // restricted.read held, people.manage NOT held: all three controls are absent.
    render(
      <MinorsSection
        detailHousehold={sampleDetail}
        access={{
          permissions: {
            "people.view": true,
            "people.manage": false,
            "people.restricted.read": true,
            "people.delete": false,
            "service_times.manage": false,
          },
          entitlements: {
            "people.directory": true,
            "people.households": true,
            "module.engagement": false,
          },
        }}
        isReadOnly={false}
      />,
    );
    expect(screen.getByRole("heading", { name: "Minors" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Guardians" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add minor" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link guardian" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Unlink/i })).toBeNull();
  });

  it("view-only caller sees none of the action controls (Pin 21)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: false, canReadMinors: false },
      listResult: {
        items: [{ householdId: sampleDetail.householdId, version: 1, label: null, adultCount: 1 }],
        nextCursor: null,
      },
      detailResult: { ...sampleDetail, label: null, minors: undefined, guardians: [] },
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    // List view has no Create household
    expect(await screen.findByRole("heading", { name: "Family Records", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create household" })).toBeNull();

    // Navigate to detail
    const viewBtn = await screen.findByRole("button", { name: "View household" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename household" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Move Arthur Clarke|Move adult/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add minor" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link guardian" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Unlink/i })).toBeNull();
  });

  it("read-only billing state hides write controls and shows read-only banner", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      billingStatus: { state: "read_only", canView: true, canManage: false },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const alerts = await screen.findAllByText("Read-only until billing is settled");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: "Create household" })).toBeNull();

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename household" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move Arthur Clarke" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add minor" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link guardian" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Unlink Arthur Clarke from Leo Clarke" }),
    ).toBeNull();
  });
});

describe("Family Records Actions - Form submissions & success flows", () => {
  const sampleDetail = {
    householdId: "00000000-0000-4000-8000-000000000001",
    version: 1,
    label: "Clarke Family",
    adults: [
      {
        personId: "00000000-0000-4000-8000-000000000010",
        givenName: "Arthur",
        familyName: "Clarke",
        version: 1,
      },
    ],
    minors: [
      {
        personId: "00000000-0000-4000-8000-000000000020",
        givenName: "Leo",
        familyName: "Clarke",
        dateOfBirth: "2015-06-12",
        version: 1,
      },
    ],
    guardians: [
      {
        linkId: "00000000-0000-4000-8000-000000000030",
        guardianId: "00000000-0000-4000-8000-000000000010",
        childId: "00000000-0000-4000-8000-000000000020",
        rights: { consent: true, pickup: true, view: true, manage: false },
      },
    ],
  };

  it("creates household with label, opens the new household detail and reloads the list", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const recordedCalls: Array<{ path: string; body: unknown }> = [];
    let listCount = 0;
    const newHouseholdId = "00000000-0000-4000-8000-000000000099";

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({
          householdsEnabled: true,
          canView: true,
          canManage: true,
          canReadMinors: true,
        });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200 },
        );
      }
      if (path === "/v1/households/list") {
        listCount++;
        const items =
          listCount === 1
            ? []
            : [
                {
                  householdId: newHouseholdId,
                  version: 1,
                  label: "New Family",
                  adultCount: 0,
                },
              ];
        return new Response(JSON.stringify({ items, nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/households/create") {
        recordedCalls.push({ path, body });
        return new Response(JSON.stringify({ householdId: newHouseholdId, version: 1 }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/households/read") {
        recordedCalls.push({ path, body });
        return new Response(
          JSON.stringify({
            householdId: newHouseholdId,
            version: 1,
            label: "New Family",
            adults: [],
            guardians: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const createBtn = await screen.findByRole("button", { name: "Create household" });
    fireEvent.click(createBtn);

    expect(await screen.findByRole("heading", { name: "Create Household" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Household name/i), {
      target: { value: "New Family" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save household" }));

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(await screen.findByText("New Family")).toBeTruthy();
    expect(listCount).toBeGreaterThan(1);
    expect(recordedCalls[0]).toEqual({
      path: "/v1/households/create",
      body: { communitySlug: SLUG, label: "New Family" },
    });
    expect(recordedCalls.some((c) => c.path === "/v1/households/read")).toBe(true);
  });

  it("renames household sending expected version and reloads detail", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const recordedCalls: Array<{ path: string; body: unknown }> = [];
    let detailCount = 0;
    const householdWithVersion7 = {
      ...sampleDetail,
      version: 7,
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({
          householdsEnabled: true,
          canView: true,
          canManage: true,
          canReadMinors: true,
        });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200 },
        );
      }
      if (path === "/v1/households/list") {
        return new Response(
          JSON.stringify({
            items: [
              {
                householdId: householdWithVersion7.householdId,
                version: 7,
                label: householdWithVersion7.label,
                adultCount: 1,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/households/read") {
        detailCount++;
        const currentDetail =
          detailCount === 1
            ? householdWithVersion7
            : { ...householdWithVersion7, label: "Renamed Household", version: 8 };
        return new Response(JSON.stringify(currentDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/households/rename") {
        recordedCalls.push({ path, body });
        return new Response(JSON.stringify({ version: 8 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const renameBtn = await screen.findByRole("button", { name: "Rename household" });
    fireEvent.click(renameBtn);

    expect(await screen.findByRole("heading", { name: "Rename Household" })).toBeTruthy();
    const input = screen.getByLabelText(/Household name/i);
    expect((input as HTMLInputElement).value).toBe("Clarke Family");
    fireEvent.change(input, { target: { value: "Renamed Household" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(await screen.findByText("Renamed Household")).toBeTruthy();
    expect(recordedCalls[0]).toEqual({
      path: "/v1/households/rename",
      body: {
        communitySlug: SLUG,
        householdId: householdWithVersion7.householdId,
        version: 7,
        label: "Renamed Household",
      },
    });
  });

  it("moves adult to target household or clears household and reloads detail", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const recordedCalls: Array<{ path: string; body: unknown }> = [];
    const detailWithAdultVersion5 = {
      ...sampleDetail,
      adults: [
        {
          ...sampleDetail.adults[0]!,
          version: 5,
        },
      ],
    };

    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: detailWithAdultVersion5.householdId,
            version: 1,
            label: detailWithAdultVersion5.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: detailWithAdultVersion5,
      moveAdultResult: { version: 6 },
      onPost: (path, body) => recordedCalls.push({ path, body }),
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const moveBtn = await screen.findByRole("button", { name: "Move Arthur Clarke" });
    fireEvent.click(moveBtn);

    expect(await screen.findByRole("heading", { name: "Move Adult" })).toBeTruthy();
    expect(screen.getByText("Arthur Clarke")).toBeTruthy();

    // Leave target empty to remove from household
    fireEvent.click(screen.getByRole("button", { name: "Save move" }));

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    const moveCall = recordedCalls.find((c) => c.path === "/v1/households/members/move-adult");
    expect(moveCall).toEqual({
      path: "/v1/households/members/move-adult",
      body: {
        communitySlug: SLUG,
        householdId: null,
        personId: detailWithAdultVersion5.adults[0]!.personId,
        version: 5,
      },
    });
  });

  it("adds minor with guardian and rights, resets form and reloads detail", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const recordedCalls: Array<{ path: string; body: unknown }> = [];

    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      addMinorResult: {
        personId: "00000000-0000-4000-8000-000000000088",
        linkId: "00000000-0000-4000-8000-000000000077",
      },
      onPost: (path, body) => recordedCalls.push({ path, body }),
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const addMinorBtn = await screen.findByRole("button", { name: "Add minor" });
    fireEvent.click(addMinorBtn);

    expect(await screen.findByRole("heading", { name: "Add Minor" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Given name/i), { target: { value: "Oliver" } });
    fireEvent.change(screen.getByLabelText(/Family name/i), { target: { value: "Clarke" } });
    fireEvent.change(screen.getByLabelText(/Date of birth/i), { target: { value: "2018-05-15" } });
    fireEvent.change(screen.getByLabelText(/Guardian/i), {
      target: { value: sampleDetail.adults[0]!.personId },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save minor" }));

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    const addCall = recordedCalls.find((c) => c.path === "/v1/households/members/add-minor");
    expect(addCall).toEqual({
      path: "/v1/households/members/add-minor",
      body: {
        communitySlug: SLUG,
        householdId: sampleDetail.householdId,
        givenName: "Oliver",
        familyName: "Clarke",
        dateOfBirth: "2018-05-15",
        guardianId: sampleDetail.adults[0]!.personId,
        rights: {
          consent: true,
          pickup: false,
          view: true,
          manage: false,
        },
      },
    });
  });

  it("links guardian to child with rights and reloads detail", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const recordedCalls: Array<{ path: string; body: unknown }> = [];

    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      linkGuardianResult: { linkId: "00000000-0000-4000-8000-000000000077" },
      onPost: (path, body) => recordedCalls.push({ path, body }),
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const linkBtn = await screen.findByRole("button", { name: "Link guardian" });
    fireEvent.click(linkBtn);

    expect(await screen.findByRole("heading", { name: "Link Guardian" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Guardian$/i), {
      target: { value: sampleDetail.adults[0]!.personId },
    });
    fireEvent.change(screen.getByLabelText(/^Child$/i), {
      target: { value: sampleDetail.minors![0]!.personId },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save link" }));

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    const linkCall = recordedCalls.find((c) => c.path === "/v1/households/guardians/link");
    expect(linkCall).toEqual({
      path: "/v1/households/guardians/link",
      body: {
        communitySlug: SLUG,
        householdId: sampleDetail.householdId,
        guardianId: sampleDetail.adults[0]!.personId,
        childId: sampleDetail.minors![0]!.personId,
        rights: {
          consent: true,
          pickup: false,
          view: true,
          manage: false,
        },
      },
    });
  });

  it("unlinks guardian after confirm step without naming child in aria-live and reloads detail", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const recordedCalls: Array<{ path: string; body: unknown }> = [];
    let detailLoads = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({
          householdsEnabled: true,
          canView: true,
          canManage: true,
          canReadMinors: true,
        });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200 },
        );
      }
      if (path === "/v1/households/list") {
        return new Response(
          JSON.stringify({
            items: [
              {
                householdId: sampleDetail.householdId,
                version: 1,
                label: sampleDetail.label,
                adultCount: 1,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/households/read") {
        detailLoads++;
        return new Response(
          JSON.stringify(detailLoads > 1 ? { ...sampleDetail, guardians: [] } : sampleDetail),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/households/guardians/unlink") {
        recordedCalls.push({ path, body });
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const unlinkBtn = await screen.findByRole("button", {
      name: "Unlink Arthur Clarke from Leo Clarke",
    });
    fireEvent.click(unlinkBtn);

    // Confirm step appears
    expect(
      await screen.findByText("Are you sure you want to remove this guardian link?"),
    ).toBeTruthy();
    const confirmBtn = screen.getByRole("button", { name: "Confirm unlink" });
    confirmBtn.focus();
    expect(document.activeElement).toBe(confirmBtn);
    fireEvent.click(confirmBtn);

    const unlinkCall = recordedCalls.find((c) => c.path === "/v1/households/guardians/unlink");
    expect(unlinkCall).toEqual({
      path: "/v1/households/guardians/unlink",
      body: {
        communitySlug: SLUG,
        householdId: sampleDetail.householdId,
        linkId: sampleDetail.guardians[0]!.linkId,
      },
    });

    // Proves detail is reloaded on success
    expect(await screen.findByText("No guardian links")).toBeTruthy();
    expect(detailLoads).toBe(2);

    // Proves focus moves to Household Details heading after unlink
    const heading = screen.getByRole("heading", { name: "Household Details", level: 2 });
    expect(document.activeElement).toBe(heading);
  });
});

describe("Family Records Actions - Error status handling & copy", () => {
  const sampleDetail = {
    householdId: "00000000-0000-4000-8000-000000000001",
    version: 1,
    label: "Clarke Family",
    adults: [
      {
        personId: "00000000-0000-4000-8000-000000000010",
        givenName: "Arthur",
        familyName: "Clarke",
        version: 1,
      },
    ],
    minors: [
      {
        personId: "00000000-0000-4000-8000-000000000020",
        givenName: "Leo",
        familyName: "Clarke",
        dateOfBirth: "2015-06-12",
        version: 1,
      },
    ],
    guardians: [
      {
        linkId: "00000000-0000-4000-8000-000000000030",
        guardianId: "00000000-0000-4000-8000-000000000010",
        childId: "00000000-0000-4000-8000-000000000020",
        rights: { consent: true, pickup: true, view: true, manage: false },
      },
    ],
  };

  it("handles 400 invalid input with generic message (no echo of values)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      createResult: 400,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const createBtn = await screen.findByRole("button", { name: "Create household" });
    fireEvent.click(createBtn);

    fireEvent.change(screen.getByLabelText(/Household name/i), { target: { value: "Invalid!!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save household" }));

    expect(await screen.findByText("Invalid input")).toBeTruthy();
    expect(screen.queryByText(/Invalid!!/i)).toBeNull();
  });

  it("handles 402 read-only billing with read-only message", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      createResult: 402,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const createBtn = await screen.findByRole("button", { name: "Create household" });
    fireEvent.click(createBtn);

    fireEvent.click(screen.getByRole("button", { name: "Save household" }));

    const alerts = await screen.findAllByText("Read-only until billing is settled");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  it("handles 403 generic not allowed message", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      createResult: 403,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const createBtn = await screen.findByRole("button", { name: "Create household" });
    fireEvent.click(createBtn);

    fireEvent.click(screen.getByRole("button", { name: "Save household" }));

    expect(await screen.findByText("Not allowed")).toBeTruthy();
  });

  it("handles 404 generic not found message", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      renameResult: 404,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const renameBtn = await screen.findByRole("button", { name: "Rename household" });
    fireEvent.click(renameBtn);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/Household not found|Not found/i)).toBeTruthy();
  });

  it("handles 409 rename conflict with stale version message and reload button", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let detailLoads = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({
          householdsEnabled: true,
          canView: true,
          canManage: true,
          canReadMinors: true,
        });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200 },
        );
      }
      if (path === "/v1/households/list") {
        return new Response(
          JSON.stringify({
            items: [
              {
                householdId: sampleDetail.householdId,
                version: 1,
                label: sampleDetail.label,
                adultCount: 1,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/households/read") {
        detailLoads++;
        return new Response(
          JSON.stringify(
            detailLoads > 1
              ? { ...sampleDetail, label: "Updated by other", version: 2 }
              : sampleDetail,
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/households/rename") {
        return new Response(null, { status: 409 });
      }
      return new Response(null, { status: 404 });
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const renameBtn = await screen.findByRole("button", { name: "Rename household" });
    fireEvent.click(renameBtn);

    const input = screen.getByLabelText(/Household name/i);
    fireEvent.change(input, { target: { value: "My Unsaved Edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(
        /This household was changed by someone else\. Reload to see the latest details; your unsaved changes will be discarded\./i,
      ),
    ).toBeTruthy();

    const reloadBtn = screen.getByRole("button", { name: "Reload" });
    fireEvent.click(reloadBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(await screen.findByText("Updated by other")).toBeTruthy();

    // Verify stale draft is discarded upon reopening rename
    const reopenRenameBtn = await screen.findByRole("button", { name: "Rename household" });
    fireEvent.click(reopenRenameBtn);
    expect(await screen.findByRole("heading", { name: "Rename Household" })).toBeTruthy();
    const reloadedInput = screen.getByLabelText(/Household name/i) as HTMLInputElement;
    expect(reloadedInput.value).toBe("Updated by other");
  });

  it("handles 409 move adult conflict with honest message and reload button (stale version or guardian links)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let detailLoads = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({
          householdsEnabled: true,
          canView: true,
          canManage: true,
          canReadMinors: true,
        });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200 },
        );
      }
      if (path === "/v1/households/list") {
        return new Response(
          JSON.stringify({
            items: [
              {
                householdId: sampleDetail.householdId,
                version: 1,
                label: sampleDetail.label,
                adultCount: 1,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/households/read") {
        detailLoads++;
        return new Response(
          JSON.stringify(
            detailLoads > 1
              ? { ...sampleDetail, label: "Updated after conflict", version: 2 }
              : sampleDetail,
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/households/members/move-adult") {
        return new Response(null, { status: 409 });
      }
      return new Response(null, { status: 404 });
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const moveBtn = await screen.findByRole("button", { name: "Move Arthur Clarke" });
    fireEvent.click(moveBtn);

    fireEvent.click(screen.getByRole("button", { name: "Save move" }));

    expect(
      await screen.findByText(
        "This change could not be applied. The adult may have guardian links, or the household changed. Reload to see the latest.",
      ),
    ).toBeTruthy();

    const reloadBtn = screen.getByRole("button", { name: "Reload" });
    fireEvent.click(reloadBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(await screen.findByText("Updated after conflict")).toBeTruthy();
  });

  it("shows honest move-adult 409 message when conflict arises from adult with guardian links", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      moveAdultResult: 409,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const moveBtn = await screen.findByRole("button", { name: "Move Arthur Clarke" });
    fireEvent.click(moveBtn);

    fireEvent.click(screen.getByRole("button", { name: "Save move" }));

    expect(
      await screen.findByText(
        "This change could not be applied. The adult may have guardian links, or the household changed. Reload to see the latest.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("handles 409 link guardian conflict with 'This guardian link already exists'", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      linkGuardianResult: 409,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const linkBtn = await screen.findByRole("button", { name: "Link guardian" });
    fireEvent.click(linkBtn);

    fireEvent.change(screen.getByLabelText(/^Guardian$/i), {
      target: { value: sampleDetail.adults[0]!.personId },
    });
    fireEvent.change(screen.getByLabelText(/^Child$/i), {
      target: { value: sampleDetail.minors![0]!.personId },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save link" }));

    expect(await screen.findByText("This guardian link already exists")).toBeTruthy();
  });

  it("handles 409 unlink guardian conflict with 'Cannot remove the last guardian'", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      unlinkGuardianResult: 409,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const unlinkBtn = await screen.findByRole("button", {
      name: "Unlink Arthur Clarke from Leo Clarke",
    });
    fireEvent.click(unlinkBtn);

    const confirmBtn = await screen.findByRole("button", { name: "Confirm unlink" });
    fireEvent.click(confirmBtn);

    expect(await screen.findByText("Cannot remove the last guardian")).toBeTruthy();
  });

  it("handles 409 add minor conflict message", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      addMinorResult: 409,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const addBtn = await screen.findByRole("button", { name: "Add minor" });
    fireEvent.click(addBtn);

    fireEvent.change(screen.getByLabelText(/Given name/i), { target: { value: "Child" } });
    fireEvent.change(screen.getByLabelText(/Family name/i), { target: { value: "Clarke" } });
    fireEvent.change(screen.getByLabelText(/Date of birth/i), { target: { value: "2018-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save minor" }));

    expect(await screen.findByText("Conflict")).toBeTruthy();
  });

  it("guards add minor submission when no guardian rights are selected", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const recordedCalls: Array<{ path: string; body: unknown }> = [];
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      onPost: (path, body) => recordedCalls.push({ path, body }),
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const addBtn = await screen.findByRole("button", { name: "Add minor" });
    fireEvent.click(addBtn);

    fireEvent.change(screen.getByLabelText(/Given name/i), { target: { value: "Child" } });
    fireEvent.change(screen.getByLabelText(/Family name/i), { target: { value: "Clarke" } });
    fireEvent.change(screen.getByLabelText(/Date of birth/i), { target: { value: "2018-01-01" } });

    // Consent and View are checked by default - uncheck both
    const consentCb = screen.getByRole("checkbox", { name: "Consent" });
    const viewCb = screen.getByRole("checkbox", { name: "View" });
    fireEvent.click(consentCb);
    fireEvent.click(viewCb);

    fireEvent.click(screen.getByRole("button", { name: "Save minor" }));

    expect(await screen.findByText("Invalid input")).toBeTruthy();
    const addCalls = recordedCalls.filter((c) => c.path === "/v1/households/members/add-minor");
    expect(addCalls).toHaveLength(0);
  });

  it("guards link guardian submission when no guardian rights are selected", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const recordedCalls: Array<{ path: string; body: unknown }> = [];
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      onPost: (path, body) => recordedCalls.push({ path, body }),
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const linkBtn = await screen.findByRole("button", { name: "Link guardian" });
    fireEvent.click(linkBtn);

    // Consent and View are checked by default - uncheck both
    const consentCb = screen.getByRole("checkbox", { name: "Consent" });
    const viewCb = screen.getByRole("checkbox", { name: "View" });
    fireEvent.click(consentCb);
    fireEvent.click(viewCb);

    fireEvent.click(screen.getByRole("button", { name: "Save link" }));

    expect(await screen.findByText("Invalid input")).toBeTruthy();
    const linkCalls = recordedCalls.filter((c) => c.path === "/v1/households/guardians/link");
    expect(linkCalls).toHaveLength(0);
  });

  it("handles 402 read-only billing message on move adult", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      moveAdultResult: 402,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const moveBtn = await screen.findByRole("button", { name: "Move Arthur Clarke" });
    fireEvent.click(moveBtn);

    fireEvent.click(screen.getByRole("button", { name: "Save move" }));

    const alerts = await screen.findAllByText("Read-only until billing is settled");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  it("handles 402 read-only billing message on add minor", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      addMinorResult: 402,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const addBtn = await screen.findByRole("button", { name: "Add minor" });
    fireEvent.click(addBtn);

    fireEvent.change(screen.getByLabelText(/Given name/i), { target: { value: "Child" } });
    fireEvent.change(screen.getByLabelText(/Family name/i), { target: { value: "Clarke" } });
    fireEvent.change(screen.getByLabelText(/Date of birth/i), { target: { value: "2018-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save minor" }));

    const alerts = await screen.findAllByText("Read-only until billing is settled");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  it("handles 402 read-only billing message on link guardian", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      linkGuardianResult: 402,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const linkBtn = await screen.findByRole("button", { name: "Link guardian" });
    fireEvent.click(linkBtn);

    fireEvent.click(screen.getByRole("button", { name: "Save link" }));

    const alerts = await screen.findAllByText("Read-only until billing is settled");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  it("handles 402 read-only billing message on unlink guardian", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      unlinkGuardianResult: 402,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const unlinkBtn = await screen.findByRole("button", {
      name: "Unlink Arthur Clarke from Leo Clarke",
    });
    fireEvent.click(unlinkBtn);

    const confirmBtn = await screen.findByRole("button", { name: "Confirm unlink" });
    fireEvent.click(confirmBtn);

    const alerts = await screen.findAllByText("Read-only until billing is settled");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Family Records Actions - Privacy & Accessibility (WCAG 2.2 AA)", () => {
  const sampleDetail = {
    householdId: "00000000-0000-4000-8000-000000000001",
    version: 1,
    label: "Clarke Family",
    adults: [
      {
        personId: "00000000-0000-4000-8000-000000000010",
        givenName: "Arthur",
        familyName: "Clarke",
        version: 1,
      },
    ],
    minors: [
      {
        personId: "00000000-0000-4000-8000-000000000020",
        givenName: "Leo",
        familyName: "Clarke",
        dateOfBirth: "2015-06-12",
        version: 1,
      },
    ],
    guardians: [
      {
        linkId: "00000000-0000-4000-8000-000000000030",
        guardianId: "00000000-0000-4000-8000-000000000010",
        childId: "00000000-0000-4000-8000-000000000020",
        rights: { consent: true, pickup: true, view: true, manage: false },
      },
    ],
  };

  it("passes axe scan on create household form", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const createBtn = await screen.findByRole("button", { name: "Create household" });
    fireEvent.click(createBtn);

    expect(await screen.findByRole("heading", { name: "Create Household" })).toBeTruthy();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("passes axe scan on rename household form and conflict alert", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      renameResult: 409,
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const renameBtn = await screen.findByRole("button", { name: "Rename household" });
    fireEvent.click(renameBtn);

    expect(await screen.findByRole("heading", { name: "Rename Household" })).toBeTruthy();
    let results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toBeTruthy();

    results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("renders move adult target select options built from loaded households with visible hint", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const otherHousehold = {
      householdId: "00000000-0000-4000-8000-000000000002",
      version: 1,
      label: "Smith Family",
      adultCount: 2,
    };

    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
          otherHousehold,
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const moveBtn = await screen.findByRole("button", { name: "Move Arthur Clarke" });
    fireEvent.click(moveBtn);

    expect(await screen.findByRole("heading", { name: "Move Adult" })).toBeTruthy();
    expect(
      screen.getByText(
        /Select a target household, or choose "No household" to remove from household\./,
      ),
    ).toBeTruthy();

    const select = screen.getByRole("combobox", { name: "Target household" }) as HTMLSelectElement;
    expect(select).toBeTruthy();
    const options = within(select).getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]?.textContent).toBe("No household");
    expect(options[0]?.getAttribute("value")).toBe("");
    expect(options[1]?.textContent).toBe("Clarke Family");
    expect(options[1]?.getAttribute("value")).toBe(sampleDetail.householdId);
    expect(options[2]?.textContent).toBe("Smith Family");
    expect(options[2]?.getAttribute("value")).toBe(otherHousehold.householdId);

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("sends selected household id when target household is chosen in move adult", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const recordedCalls: Array<{ path: string; body: unknown }> = [];
    const otherHousehold = {
      householdId: "00000000-0000-4000-8000-000000000002",
      version: 1,
      label: "Smith Family",
      adultCount: 2,
    };

    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
          otherHousehold,
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      moveAdultResult: { version: 2 },
      onPost: (path, body) => recordedCalls.push({ path, body }),
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const moveBtn = await screen.findByRole("button", { name: "Move Arthur Clarke" });
    fireEvent.click(moveBtn);

    const select = await screen.findByRole("combobox", { name: "Target household" });
    fireEvent.change(select, { target: { value: otherHousehold.householdId } });

    fireEvent.click(screen.getByRole("button", { name: "Save move" }));

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    const moveCall = recordedCalls.find((c) => c.path === "/v1/households/members/move-adult");
    expect(moveCall).toEqual({
      path: "/v1/households/members/move-adult",
      body: {
        communitySlug: SLUG,
        householdId: otherHousehold.householdId,
        personId: sampleDetail.adults[0]!.personId,
        version: 1,
      },
    });
  });

  it("indicates only loaded households are offered when household list is paged", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: "cursor-page-2",
      },
      detailResult: sampleDetail,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const moveBtn = await screen.findByRole("button", { name: "Move Arthur Clarke" });
    fireEvent.click(moveBtn);

    expect(await screen.findByRole("heading", { name: "Move Adult" })).toBeTruthy();
    expect(
      screen.getByText(
        "The household list is paged. Only currently loaded households are offered.",
      ),
    ).toBeTruthy();
  });

  it("passes axe scan on move adult form and conflict alert", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      moveAdultResult: 409,
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const moveBtn = await screen.findByRole("button", { name: "Move Arthur Clarke" });
    fireEvent.click(moveBtn);

    expect(await screen.findByRole("heading", { name: "Move Adult" })).toBeTruthy();
    let results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Save move" }));
    expect(await screen.findByRole("alert")).toBeTruthy();

    results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("passes axe scan on add minor form", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const addMinorBtn = await screen.findByRole("button", { name: "Add minor" });
    fireEvent.click(addMinorBtn);

    expect(await screen.findByRole("heading", { name: "Add Minor" })).toBeTruthy();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("passes axe scan on link guardian form", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const linkBtn = await screen.findByRole("button", { name: "Link guardian" });
    fireEvent.click(linkBtn);

    expect(await screen.findByRole("heading", { name: "Link Guardian" })).toBeTruthy();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("passes axe scan on unlink confirmation state", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const unlinkBtn = await screen.findByRole("button", {
      name: "Unlink Arthur Clarke from Leo Clarke",
    });
    fireEvent.click(unlinkBtn);

    expect(
      await screen.findByText("Are you sure you want to remove this guardian link?"),
    ).toBeTruthy();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("no minor names, dates of birth or ids in alerts, URLs, or document title", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      addMinorResult: 400,
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
    fireEvent.click(viewBtn);

    const addMinorBtn = await screen.findByRole("button", { name: "Add minor" });
    fireEvent.click(addMinorBtn);

    fireEvent.change(screen.getByLabelText(/Given name/i), { target: { value: "SecretChild" } });
    fireEvent.change(screen.getByLabelText(/Family name/i), { target: { value: "Confidential" } });
    fireEvent.change(screen.getByLabelText(/Date of birth/i), { target: { value: "2016-01-01" } });
    fireEvent.change(screen.getByLabelText(/Guardian/i), {
      target: { value: sampleDetail.adults[0]!.personId },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save minor" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("SecretChild");
    expect(alert.textContent).not.toContain("Confidential");
    expect(alert.textContent).not.toContain("2016-01-01");
    expect(window.location.href).not.toContain("SecretChild");
    expect(window.location.href).not.toContain("2016-01-01");
    expect(document.title).not.toContain("SecretChild");
    expect(sessionStorage.getItem("minor-dob")).toBeNull();
  });
});

describe("Family Details restyle & security pins (Task 9)", () => {
  const HIDDEN_NOTICE = "Household names and children are hidden for your role.";

  const sampleDetail = {
    householdId: "00000000-0000-4000-8000-000000000001",
    version: 1,
    label: "Clarke Family",
    adults: [
      {
        personId: "00000000-0000-4000-8000-000000000010",
        givenName: "Arthur",
        familyName: "Clarke",
        version: 1,
      },
    ],
    minors: [
      {
        personId: "00000000-0000-4000-8000-000000000020",
        givenName: "Leo",
        familyName: "Clarke",
        dateOfBirth: "2015-06-12",
        version: 1,
      },
    ],
    guardians: [
      {
        linkId: "00000000-0000-4000-8000-000000000030",
        guardianId: "00000000-0000-4000-8000-000000000010",
        childId: "00000000-0000-4000-8000-000000000020",
        rights: {
          consent: true,
          pickup: true,
          view: true,
          manage: false,
        },
      },
    ],
  };

  describe("Pin 30: no Household name row when label is null", () => {
    it("hides 'Household name:' row for caller with people.restricted.read when label is null (Pin 30)", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      mockApi({
        access: { householdsEnabled: true, canView: true, canReadMinors: true },
        listResult: {
          items: [
            {
              householdId: sampleDetail.householdId,
              version: 1,
              label: null,
              adultCount: 1,
            },
          ],
          nextCursor: null,
        },
        detailResult: { ...sampleDetail, label: null },
      });

      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      const viewBtn = await screen.findByRole("button", { name: "View household" });
      fireEvent.click(viewBtn);

      expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
      expect(screen.queryByText("Household name:")).toBeNull();
      expect(screen.queryByText(/Household name:/i)).toBeNull();
    });

    it("hides 'Household name:' row for caller without people.restricted.read when label is null (Pin 30)", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      mockApi({
        access: { householdsEnabled: true, canView: true, canReadMinors: false },
        listResult: {
          items: [
            {
              householdId: sampleDetail.householdId,
              version: 1,
              label: null,
              adultCount: 1,
            },
          ],
          nextCursor: null,
        },
        detailResult: { ...sampleDetail, label: null },
      });

      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      const viewBtn = await screen.findByRole("button", { name: "View household" });
      fireEvent.click(viewBtn);

      expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
      expect(screen.queryByText("Household name:")).toBeNull();
      expect(screen.queryByText(/Household name:/i)).toBeNull();
    });
  });

  describe("Pin 40: new line alert visibility on Family Details in both directions", () => {
    it("shows the new line alert without people.restricted.read on Family Details across pending, loaded, 404, and error states with role='status' (Pin 40)", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);

      // State 1: pending detail request
      let resolveDetail: ((res: Response) => void) | undefined;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({
            householdsEnabled: true,
            canView: true,
            canReadMinors: false,
          });
        }
        if (path === "/v1/billing/status") {
          return new Response(
            JSON.stringify({
              state: "ok",
              trial_end: null,
              grace_until: null,
              canView: true,
              canManage: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (path === "/v1/households/list") {
          return new Response(
            JSON.stringify({
              items: [
                {
                  householdId: sampleDetail.householdId,
                  version: 1,
                  label: null,
                  adultCount: 1,
                },
              ],
              nextCursor: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (path === "/v1/households/read") {
          return new Promise<Response>((resolve) => {
            resolveDetail = resolve;
          });
        }
        return new Response(null, { status: 404 });
      });

      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      const viewBtn = await screen.findByRole("button", { name: "View household" });
      fireEvent.click(viewBtn);

      // State 1: Pending detail request
      await waitFor(() => {
        expect(resolveDetail).toBeDefined();
      });
      const pendingNotice = screen.getByText(HIDDEN_NOTICE);
      expect(pendingNotice).toBeTruthy();
      expect(
        pendingNotice.getAttribute("role") ??
          pendingNotice.closest('[role="status"]')?.getAttribute("role"),
      ).toBe("status");

      // State 2: Loaded
      resolveDetail!(
        new Response(
          JSON.stringify({
            householdId: sampleDetail.householdId,
            version: 1,
            label: null,
            adults: sampleDetail.adults,
            guardians: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      expect(await screen.findByText("Arthur")).toBeTruthy();
      const loadedNotice = screen.getByText(HIDDEN_NOTICE);
      expect(loadedNotice).toBeTruthy();
      expect(
        loadedNotice.getAttribute("role") ??
          loadedNotice.closest('[role="status"]')?.getAttribute("role"),
      ).toBe("status");

      cleanup();

      // State 3: 404 not found
      mockApi({
        access: { householdsEnabled: true, canView: true, canReadMinors: false },
        listResult: {
          items: [
            {
              householdId: sampleDetail.householdId,
              version: 1,
              label: null,
              adultCount: 1,
            },
          ],
          nextCursor: null,
        },
        detailResult: 404,
      });
      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));
      fireEvent.click(await screen.findByRole("button", { name: "View household" }));
      expect(await screen.findByText("Household not found")).toBeTruthy();
      const notFoundNotice = screen.getByText(HIDDEN_NOTICE);
      expect(notFoundNotice).toBeTruthy();
      expect(
        notFoundNotice.getAttribute("role") ??
          notFoundNotice.closest('[role="status"]')?.getAttribute("role"),
      ).toBe("status");

      cleanup();

      // State 4: 500 error
      mockApi({
        access: { householdsEnabled: true, canView: true, canReadMinors: false },
        listResult: {
          items: [
            {
              householdId: sampleDetail.householdId,
              version: 1,
              label: null,
              adultCount: 1,
            },
          ],
          nextCursor: null,
        },
        detailResult: 500,
      });
      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));
      fireEvent.click(await screen.findByRole("button", { name: "View household" }));
      expect(await screen.findByText("Failed to load household")).toBeTruthy();
      const errorNotice = screen.getByText(HIDDEN_NOTICE);
      expect(errorNotice).toBeTruthy();
      expect(
        errorNotice.getAttribute("role") ??
          errorNotice.closest('[role="status"]')?.getAttribute("role"),
      ).toBe("status");
    });

    it("does not show the new line alert on Family Details with people.restricted.read across pending, loaded, 404, error, and not when Not allowed (Pin 40)", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);

      // State 1: pending detail request
      let resolveDetail: ((res: Response) => void) | undefined;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({
            householdsEnabled: true,
            canView: true,
            canReadMinors: true,
          });
        }
        if (path === "/v1/billing/status") {
          return new Response(
            JSON.stringify({
              state: "ok",
              trial_end: null,
              grace_until: null,
              canView: true,
              canManage: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (path === "/v1/households/list") {
          return new Response(
            JSON.stringify({
              items: [
                {
                  householdId: sampleDetail.householdId,
                  version: 1,
                  label: "Clarke Family",
                  adultCount: 1,
                },
              ],
              nextCursor: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (path === "/v1/households/read") {
          return new Promise<Response>((resolve) => {
            resolveDetail = resolve;
          });
        }
        return new Response(null, { status: 404 });
      });

      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      const viewBtn = await screen.findByRole("button", { name: "View Clarke Family" });
      fireEvent.click(viewBtn);

      // State 1: Pending
      await waitFor(() => {
        expect(resolveDetail).toBeDefined();
        expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
      });
      expect(screen.queryByText(HIDDEN_NOTICE)).toBeNull();

      // State 2: Loaded
      resolveDetail!(
        new Response(JSON.stringify(sampleDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      expect(await screen.findByText("Arthur")).toBeTruthy();
      expect(screen.queryByText(HIDDEN_NOTICE)).toBeNull();

      cleanup();

      // State 3: 404
      mockApi({
        access: { householdsEnabled: true, canView: true, canReadMinors: true },
        listResult: {
          items: [
            {
              householdId: sampleDetail.householdId,
              version: 1,
              label: "Clarke Family",
              adultCount: 1,
            },
          ],
          nextCursor: null,
        },
        detailResult: 404,
      });
      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));
      fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
      expect(await screen.findByText("Household not found")).toBeTruthy();
      expect(screen.queryByText(HIDDEN_NOTICE)).toBeNull();

      cleanup();

      // State 4: 500 error
      mockApi({
        access: { householdsEnabled: true, canView: true, canReadMinors: true },
        listResult: {
          items: [
            {
              householdId: sampleDetail.householdId,
              version: 1,
              label: "Clarke Family",
              adultCount: 1,
            },
          ],
          nextCursor: null,
        },
        detailResult: 500,
      });
      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));
      fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
      expect(await screen.findByText("Failed to load household")).toBeTruthy();
      expect(screen.queryByText(HIDDEN_NOTICE)).toBeNull();

      cleanup();

      // State 5: Not allowed
      mockApi({
        access: { householdsEnabled: false, canView: true, canReadMinors: false },
      });
      await showFamilyRecords();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));
      expect(await screen.findByText("Not allowed")).toBeTruthy();
      expect(screen.queryByText(HIDDEN_NOTICE)).toBeNull();
    });
  });

  it("restricted data must-fail: caller without people.restricted.read sees no minor names, DOBs, headings or word 'Minor'", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const detailWithMinor = {
      householdId: "00000000-0000-4000-8000-000000000001",
      version: 1,
      label: null,
      adults: [
        {
          personId: "00000000-0000-4000-8000-000000000010",
          givenName: "Arthur",
          familyName: "Tolland",
          version: 1,
        },
      ],
      minors: [
        {
          personId: "00000000-0000-4000-8000-000000000020",
          givenName: "Pip",
          familyName: "Tolland",
          dateOfBirth: "2016-03-14",
          version: 1,
        },
      ],
      guardians: [
        {
          linkId: "00000000-0000-4000-8000-000000000030",
          guardianId: "00000000-0000-4000-8000-000000000010",
          childId: "00000000-0000-4000-8000-000000000020",
          rights: { consent: true, pickup: false, view: true, manage: false },
        },
      ],
    };

    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: false },
      listResult: {
        items: [
          {
            householdId: detailWithMinor.householdId,
            version: 1,
            label: null,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: detailWithMinor,
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const viewBtn = await screen.findByRole("button", { name: "View household" });
    fireEvent.click(viewBtn);

    expect(await screen.findByRole("heading", { name: "Household Details" })).toBeTruthy();
    expect(await screen.findByText("Arthur")).toBeTruthy();

    expect(screen.queryByText(/Pip/i)).toBeNull();
    expect(screen.queryByText(/2016/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Minors" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Guardians" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/minor/i);

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("renders Avatar in Adult members table with aria-hidden=true and none in Minor members table", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));

    const adultTable = await screen.findByRole("table", { name: "Adult members" });
    const adultAvatars = adultTable.querySelectorAll('[data-slot="avatar"]');
    expect(adultAvatars.length).toBe(sampleDetail.adults.length);
    adultAvatars.forEach((avatar) => {
      expect(avatar.getAttribute("aria-hidden")).toBe("true");
    });

    const minorTable = await screen.findByRole("table", { name: "Minor members" });
    const minorAvatars = minorTable.querySelectorAll('[data-slot="avatar"]');
    expect(minorAvatars.length).toBe(0);

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("renders panels in order: Household Details (h2), Adults (h3), Minors (h3), Guardians (h3) with their actions and life events", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));

    const hAdults = await screen.findByRole("heading", { name: "Adults", level: 3 });
    const hHousehold = screen.getByRole("heading", {
      name: "Household Details",
      level: 2,
    });
    const hMinors = screen.getByRole("heading", { name: "Minors", level: 3 });
    const hGuardians = screen.getByRole("heading", { name: "Guardians", level: 3 });

    expect(
      Boolean(hHousehold.compareDocumentPosition(hAdults) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(hAdults.compareDocumentPosition(hMinors) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(hMinors.compareDocumentPosition(hGuardians) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);

    const householdSection = hHousehold.closest<HTMLElement>('section[data-slot="panel"]');
    expect(householdSection).not.toBeNull();
    expect(within(householdSection!).getByRole("button", { name: "Back to list" })).toBeTruthy();
    expect(
      within(householdSection!).getByRole("button", { name: "Rename household" }),
    ).toBeTruthy();

    const adultsSection = hAdults.closest<HTMLElement>('section[data-slot="panel"]');
    expect(adultsSection).not.toBeNull();
    expect(within(adultsSection!).getByRole("button", { name: "Add adult" })).toBeTruthy();

    const minorsSection = hMinors.closest<HTMLElement>('section[data-slot="panel"]');
    expect(minorsSection).not.toBeNull();
    expect(within(minorsSection!).getByRole("button", { name: "Add minor" })).toBeTruthy();

    const guardiansSection = hGuardians.closest<HTMLElement>('section[data-slot="panel"]');
    expect(guardiansSection).not.toBeNull();
    expect(within(guardiansSection!).getByRole("button", { name: "Link guardian" })).toBeTruthy();

    // Adult life events inside Adults section, after Adult members table
    const adultLifeEvents = within(adultsSection!).getByText(/Life events: Arthur Clarke/i);
    expect(adultLifeEvents).toBeTruthy();
    const adultTable = within(adultsSection!).getByRole("table", { name: "Adult members" });
    expect(
      Boolean(
        adultTable.compareDocumentPosition(adultLifeEvents) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    // Minor life events inside Minors section
    const minorLifeEvents = within(minorsSection!).getByText(/Life events: Leo Clarke/i);
    expect(minorLifeEvents).toBeTruthy();

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("renders Skeleton aria-hidden with sr-only loading text and keeps Household Details heading mounted during pending, 404, and error", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);

    let resolveDetail: ((res: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({
          householdsEnabled: true,
          canView: true,
          canReadMinors: true,
        });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/households/list") {
        return new Response(
          JSON.stringify({
            items: [
              {
                householdId: sampleDetail.householdId,
                version: 1,
                label: sampleDetail.label,
                adultCount: 1,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/households/read") {
        return new Promise<Response>((resolve) => {
          resolveDetail = resolve;
        });
      }
      return new Response(null, { status: 404 });
    });

    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));

    // Pending state
    await waitFor(() => {
      expect(resolveDetail).toBeDefined();
    });
    const skeleton = document.querySelector('[data-slot="skeleton"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute("aria-hidden")).toBe("true");

    const loadingSpan = screen.getByText("Loading household details...");
    expect(loadingSpan.tagName.toLowerCase()).toBe("span");
    expect(loadingSpan.className).toContain("sr-only");
    expect(loadingSpan.getAttribute("role")).toBeNull();
    expect(loadingSpan.getAttribute("aria-live")).toBeNull();

    expect(screen.getByRole("heading", { name: "Household Details", level: 2 })).toBeTruthy();

    // Settle detail promise
    resolveDetail!(
      new Response(JSON.stringify(sampleDetail), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await screen.findByText("Arthur")).toBeTruthy();

    cleanup();

    // 404 state
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: 404,
    });
    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));

    expect(await screen.findByText("Household not found")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Household Details", level: 2 })).toBeTruthy();

    cleanup();

    // Failed load (500) state
    mockApi({
      access: { householdsEnabled: true, canView: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: 500,
    });
    await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));

    expect(await screen.findByText("Failed to load household")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Household Details", level: 2 })).toBeTruthy();
  });

  it("renders inline unlink confirm message, Confirm unlink, and Cancel inside the row's cell", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));

    const guardianTable = await screen.findByRole("table", { name: "Guardian links" });
    const unlinkBtn = within(guardianTable).getByRole("button", {
      name: "Unlink Arthur Clarke from Leo Clarke",
    });
    const cell = unlinkBtn.closest("td");
    expect(cell).not.toBeNull();

    fireEvent.click(unlinkBtn);

    expect(
      within(cell!).getByText("Are you sure you want to remove this guardian link?"),
    ).toBeTruthy();
    expect(within(cell!).getByRole("button", { name: "Confirm unlink" })).toBeTruthy();
    expect(within(cell!).getByRole("button", { name: "Cancel" })).toBeTruthy();

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });
});

describe("Family forms restyle & security pins (Task 10)", () => {
  const sampleDetail = {
    householdId: "00000000-0000-4000-8000-000000000001",
    version: 1,
    label: "Clarke Family",
    adults: [
      {
        personId: "00000000-0000-4000-8000-000000000010",
        givenName: "Arthur",
        familyName: "Clarke",
        version: 1,
      },
    ],
    minors: [
      {
        personId: "00000000-0000-4000-8000-000000000020",
        givenName: "Leo",
        familyName: "Clarke",
        dateOfBirth: "2015-06-12",
        version: 1,
      },
    ],
    guardians: [
      {
        linkId: "00000000-0000-4000-8000-000000000030",
        guardianId: "00000000-0000-4000-8000-000000000010",
        childId: "00000000-0000-4000-8000-000000000020",
        rights: {
          consent: true,
          pickup: true,
          view: true,
          manage: false,
        },
      },
    ],
  };

  const fullAccess: PeopleAccess = {
    permissions: {
      "people.view": true,
      "people.manage": true,
      "people.restricted.read": true,
      "people.delete": false,
      "service_times.manage": false,
    },
    entitlements: {
      "people.directory": true,
      "people.households": true,
      "module.engagement": false,
    },
  };

  const accessWithoutRestricted: PeopleAccess = {
    ...fullAccess,
    permissions: {
      ...fullAccess.permissions,
      "people.restricted.read": false,
    },
  };

  it("renders move adult target select with data-slot and aria-describedby referencing target hint (and paged notice when paged)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    sessionStorage.setItem("community-hub.community", SLUG);

    // First case: unpaged list (nextCursor is null)
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    const { unmount } = render(
      <PeopleAccessContext.Provider value={{ access: fullAccess }}>
        <CommunityProvider>
          <BillingStatusProvider>
            <MemoryRouter initialEntries={["/family-records"]}>
              <FamilyRecordsPage />
            </MemoryRouter>
          </BillingStatusProvider>
        </CommunityProvider>
      </PeopleAccessContext.Provider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Move Arthur Clarke" }));

    expect(await screen.findByRole("heading", { name: "Move Adult" })).toBeTruthy();

    const selectUnpaged = screen.getByRole("combobox", { name: "Target household" });
    expect(selectUnpaged.getAttribute("data-slot")).toBe("select");
    const unpagedDescribedBy = selectUnpaged.getAttribute("aria-describedby");
    expect(unpagedDescribedBy).toContain("move-adult-target-hint");
    expect(unpagedDescribedBy).not.toContain("move-adult-paged-notice");
    expect(document.getElementById("move-adult-target-hint")?.textContent).toBe(
      'Select a target household, or choose "No household" to remove from household.',
    );

    unmount();

    // Second case: paged list (nextCursor is set)
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: "synthetic-next-cursor",
      },
      detailResult: sampleDetail,
    });

    render(
      <PeopleAccessContext.Provider value={{ access: fullAccess }}>
        <CommunityProvider>
          <BillingStatusProvider>
            <MemoryRouter initialEntries={["/family-records"]}>
              <FamilyRecordsPage />
            </MemoryRouter>
          </BillingStatusProvider>
        </CommunityProvider>
      </PeopleAccessContext.Provider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Move Arthur Clarke" }));

    expect(await screen.findByRole("heading", { name: "Move Adult" })).toBeTruthy();

    const selectPaged = screen.getByRole("combobox", { name: "Target household" });
    expect(selectPaged.getAttribute("data-slot")).toBe("select");
    const pagedDescribedBy = selectPaged.getAttribute("aria-describedby");
    expect(pagedDescribedBy).toContain("move-adult-target-hint");
    expect(pagedDescribedBy).toContain("move-adult-paged-notice");
    expect(document.getElementById("move-adult-paged-notice")?.textContent).toBe(
      "The household list is paged. Only currently loaded households are offered.",
    );
  });

  it("Pin 42: prevents add minor submission when caller access loses people.restricted.read while form is open", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    sessionStorage.setItem("community-hub.community", SLUG);
    const postCalls: Array<{ path: string; body: unknown }> = [];

    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      onPost: (path, body) => postCalls.push({ path, body }),
    });

    const { rerender } = render(
      <PeopleAccessContext.Provider value={{ access: fullAccess }}>
        <CommunityProvider>
          <BillingStatusProvider>
            <MemoryRouter initialEntries={["/family-records"]}>
              <FamilyRecordsPage />
            </MemoryRouter>
          </BillingStatusProvider>
        </CommunityProvider>
      </PeopleAccessContext.Provider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add minor" }));

    expect(await screen.findByRole("heading", { name: "Add Minor" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Given name/i), { target: { value: "Penny" } });
    fireEvent.change(screen.getByLabelText(/Family name/i), { target: { value: "Clarke" } });
    fireEvent.change(screen.getByLabelText(/Date of birth/i), { target: { value: "2019-06-20" } });
    fireEvent.change(screen.getByLabelText(/Guardian/i), {
      target: { value: sampleDetail.adults[0]!.personId },
    });

    // Re-render with the same tree but without people.restricted.read
    rerender(
      <PeopleAccessContext.Provider value={{ access: accessWithoutRestricted }}>
        <CommunityProvider>
          <BillingStatusProvider>
            <MemoryRouter initialEntries={["/family-records"]}>
              <FamilyRecordsPage />
            </MemoryRouter>
          </BillingStatusProvider>
        </CommunityProvider>
      </PeopleAccessContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save minor" }));

    expect(postCalls.filter((c) => c.path === "/v1/households/members/add-minor")).toHaveLength(0);
  });

  it("Pin 43: prevents link guardian submission when caller access loses people.restricted.read while form is open", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    sessionStorage.setItem("community-hub.community", SLUG);
    const postCalls: Array<{ path: string; body: unknown }> = [];

    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      onPost: (path, body) => postCalls.push({ path, body }),
    });

    const { rerender } = render(
      <PeopleAccessContext.Provider value={{ access: fullAccess }}>
        <CommunityProvider>
          <BillingStatusProvider>
            <MemoryRouter initialEntries={["/family-records"]}>
              <FamilyRecordsPage />
            </MemoryRouter>
          </BillingStatusProvider>
        </CommunityProvider>
      </PeopleAccessContext.Provider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Link guardian" }));

    expect(await screen.findByRole("heading", { name: "Link Guardian" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Guardian$/i), {
      target: { value: sampleDetail.adults[0]!.personId },
    });
    fireEvent.change(screen.getByLabelText(/^Child$/i), {
      target: { value: sampleDetail.minors![0]!.personId },
    });

    // Re-render with the same tree but without people.restricted.read
    rerender(
      <PeopleAccessContext.Provider value={{ access: accessWithoutRestricted }}>
        <CommunityProvider>
          <BillingStatusProvider>
            <MemoryRouter initialEntries={["/family-records"]}>
              <FamilyRecordsPage />
            </MemoryRouter>
          </BillingStatusProvider>
        </CommunityProvider>
      </PeopleAccessContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save link" }));

    expect(postCalls.filter((c) => c.path === "/v1/households/guardians/link")).toHaveLength(0);
  });

  it("renders styled controls in Add Minor and Link Guardian forms", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    sessionStorage.setItem("community-hub.community", SLUG);

    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    const { unmount } = render(
      <PeopleAccessContext.Provider value={{ access: fullAccess }}>
        <CommunityProvider>
          <BillingStatusProvider>
            <MemoryRouter initialEntries={["/family-records"]}>
              <FamilyRecordsPage />
            </MemoryRouter>
          </BillingStatusProvider>
        </CommunityProvider>
      </PeopleAccessContext.Provider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add minor" }));

    expect(await screen.findByRole("heading", { name: "Add Minor" })).toBeTruthy();

    const addMinorGroup = screen.getByRole("group", { name: "Guardian rights" });
    expect(within(addMinorGroup).getByRole("checkbox", { name: "Consent" })).toBeTruthy();
    expect(within(addMinorGroup).getByRole("checkbox", { name: "Pickup" })).toBeTruthy();
    expect(within(addMinorGroup).getByRole("checkbox", { name: "View" })).toBeTruthy();
    expect(within(addMinorGroup).getByRole("checkbox", { name: "Manage" })).toBeTruthy();

    const guardianSelect = screen.getByRole("combobox", { name: "Guardian" });
    expect(guardianSelect.getAttribute("data-slot")).toBe("select");

    // Cancel back to detail
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Open Link Guardian
    fireEvent.click(await screen.findByRole("button", { name: "Link guardian" }));
    expect(await screen.findByRole("heading", { name: "Link Guardian" })).toBeTruthy();

    const linkGuardianSelect = screen.getByRole("combobox", { name: "Guardian" });
    expect(linkGuardianSelect.getAttribute("data-slot")).toBe("select");

    const linkChildSelect = screen.getByRole("combobox", { name: "Child" });
    expect(linkChildSelect.getAttribute("data-slot")).toBe("select");

    const linkGroup = screen.getByRole("group", { name: "Guardian rights" });
    expect(within(linkGroup).getByRole("checkbox", { name: "Consent" })).toBeTruthy();
    expect(within(linkGroup).getByRole("checkbox", { name: "Pickup" })).toBeTruthy();
    expect(within(linkGroup).getByRole("checkbox", { name: "View" })).toBeTruthy();
    expect(within(linkGroup).getByRole("checkbox", { name: "Manage" })).toBeTruthy();

    unmount();
  });

  it("renders FilterBar, disabled search, skeleton and sr-only searching text during Add Adult search, EmptyState when empty, and DataTable without avatar for results", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    sessionStorage.setItem("community-hub.community", SLUG);

    let resolvePeopleList: ((response: Response) => void) | undefined;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/households/list") {
        return new Response(
          JSON.stringify({
            items: [
              {
                householdId: sampleDetail.householdId,
                version: 1,
                label: sampleDetail.label,
                adultCount: 1,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/households/read") {
        return new Response(JSON.stringify(sampleDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/list") {
        return new Promise<Response>((resolve) => {
          resolvePeopleList = resolve;
        });
      }
      return new Response(null, { status: 404 });
    });

    render(
      <PeopleAccessContext.Provider value={{ access: fullAccess }}>
        <CommunityProvider>
          <BillingStatusProvider>
            <MemoryRouter initialEntries={["/family-records"]}>
              <FamilyRecordsPage />
            </MemoryRouter>
          </BillingStatusProvider>
        </CommunityProvider>
      </PeopleAccessContext.Provider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add adult" }));

    expect(await screen.findByRole("heading", { name: "Add Adult" })).toBeTruthy();

    const searchInput = screen.getByRole("textbox", { name: "Search adults" });
    fireEvent.change(searchInput, { target: { value: "Franklin" } });

    const searchBtn = screen.getByRole("button", { name: "Search" });
    fireEvent.click(searchBtn);

    // While search is pending:
    expect(searchBtn.hasAttribute("disabled")).toBe(true);

    const skeleton = document.querySelector('[data-slot="skeleton"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute("aria-hidden")).toBe("true");

    const searchingSpan = screen.getByText("Searching...");
    expect(searchingSpan.tagName.toLowerCase()).toBe("span");
    expect(searchingSpan.className).toContain("sr-only");
    expect(searchingSpan.getAttribute("role")).toBeNull();
    expect(searchingSpan.getAttribute("aria-live")).toBeNull();

    // Resolve with no results
    await act(async () => {
      resolvePeopleList!(
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    expect(await screen.findByText("No adults found")).toBeTruthy();

    // Now perform a second search with results
    fireEvent.change(searchInput, { target: { value: "Vance" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await act(async () => {
      resolvePeopleList!(
        new Response(
          JSON.stringify({
            items: [
              {
                personId: "person-synthetic-99",
                givenName: "Eleanor",
                familyName: "Vance",
                version: 1,
              },
            ],
            nextCursor: null,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    });

    const table = await screen.findByRole("table", { name: "Adult search results" });
    expect(table).toBeTruthy();
    expect(table.querySelector('[data-slot="avatar"]')).toBeNull();
    expect(within(table).getByText("Eleanor")).toBeTruthy();
    expect(within(table).getByText("Vance")).toBeTruthy();
    expect(
      within(table).getByRole("button", { name: "Add Eleanor Vance to household" }),
    ).toBeTruthy();
  });

  it("renders each of the six form views inside a section with an h2 heading that receives focus", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    sessionStorage.setItem("community-hub.community", SLUG);

    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
    });

    render(
      <PeopleAccessContext.Provider value={{ access: fullAccess }}>
        <CommunityProvider>
          <BillingStatusProvider>
            <MemoryRouter initialEntries={["/family-records"]}>
              <FamilyRecordsPage />
            </MemoryRouter>
          </BillingStatusProvider>
        </CommunityProvider>
      </PeopleAccessContext.Provider>,
    );

    // 1. Create view
    fireEvent.click(await screen.findByRole("button", { name: "Create household" }));
    const createHeading = await screen.findByRole("heading", {
      name: "Create Household",
      level: 2,
    });
    expect(createHeading.closest("section")).not.toBeNull();
    expect(document.activeElement).toBe(createHeading);

    // Cancel back to list
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Navigate to detail
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));

    // 2. Rename view
    fireEvent.click(await screen.findByRole("button", { name: "Rename household" }));
    const renameHeading = await screen.findByRole("heading", {
      name: "Rename Household",
      level: 2,
    });
    expect(renameHeading.closest("section")).not.toBeNull();
    expect(document.activeElement).toBe(renameHeading);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // 3. Add adult view
    fireEvent.click(await screen.findByRole("button", { name: "Add adult" }));
    const addAdultHeading = await screen.findByRole("heading", { name: "Add Adult", level: 2 });
    expect(addAdultHeading.closest("section")).not.toBeNull();
    expect(document.activeElement).toBe(addAdultHeading);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // 4. Move adult view
    fireEvent.click(await screen.findByRole("button", { name: "Move Arthur Clarke" }));
    const moveAdultHeading = await screen.findByRole("heading", {
      name: "Move Adult",
      level: 2,
    });
    expect(moveAdultHeading.closest("section")).not.toBeNull();
    expect(document.activeElement).toBe(moveAdultHeading);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // 5. Add minor view
    fireEvent.click(await screen.findByRole("button", { name: "Add minor" }));
    const addMinorHeading = await screen.findByRole("heading", { name: "Add Minor", level: 2 });
    expect(addMinorHeading.closest("section")).not.toBeNull();
    expect(document.activeElement).toBe(addMinorHeading);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // 6. Link guardian view
    fireEvent.click(await screen.findByRole("button", { name: "Link guardian" }));
    const linkGuardianHeading = await screen.findByRole("heading", {
      name: "Link Guardian",
      level: 2,
    });
    expect(linkGuardianHeading.closest("section")).not.toBeNull();
    expect(document.activeElement).toBe(linkGuardianHeading);
  });

  it.each([
    { right: "consent", label: "Consent" },
    { right: "pickup", label: "Pickup" },
    { right: "view", label: "View" },
    { right: "manage", label: "Manage" },
  ] as const)(
    "pins Add Minor guardian right $right to checkbox $label",
    async ({ right, label }) => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      sessionStorage.setItem("community-hub.community", SLUG);
      const postCalls: Array<{ path: string; body: unknown }> = [];

      mockApi({
        access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
        listResult: {
          items: [
            {
              householdId: sampleDetail.householdId,
              version: 1,
              label: sampleDetail.label,
              adultCount: 1,
            },
          ],
          nextCursor: null,
        },
        detailResult: sampleDetail,
        onPost: (path, body) => postCalls.push({ path, body }),
      });

      render(
        <PeopleAccessContext.Provider value={{ access: fullAccess }}>
          <CommunityProvider>
            <BillingStatusProvider>
              <MemoryRouter initialEntries={["/family-records"]}>
                <FamilyRecordsPage />
              </MemoryRouter>
            </BillingStatusProvider>
          </CommunityProvider>
        </PeopleAccessContext.Provider>,
      );

      fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
      fireEvent.click(await screen.findByRole("button", { name: "Add minor" }));
      expect(await screen.findByRole("heading", { name: "Add Minor" })).toBeTruthy();

      fireEvent.change(screen.getByLabelText(/Given name/i), { target: { value: "Corin" } });
      fireEvent.change(screen.getByLabelText(/Family name/i), { target: { value: "Blythe" } });
      fireEvent.change(screen.getByLabelText(/Date of birth/i), {
        target: { value: "2017-04-12" },
      });
      fireEvent.change(screen.getByLabelText(/Guardian/i), {
        target: { value: sampleDetail.adults[0]!.personId },
      });

      const consentCb = screen.getByRole("checkbox", { name: "Consent" }) as HTMLInputElement;
      const pickupCb = screen.getByRole("checkbox", { name: "Pickup" }) as HTMLInputElement;
      const viewCb = screen.getByRole("checkbox", { name: "View" }) as HTMLInputElement;
      const manageCb = screen.getByRole("checkbox", { name: "Manage" }) as HTMLInputElement;

      // Consent and View are checked by default — uncheck both
      fireEvent.click(consentCb);
      fireEvent.click(viewCb);

      const targetCb = screen.getByRole("checkbox", { name: label });
      fireEvent.click(targetCb);

      const checkboxes = {
        consent: consentCb,
        pickup: pickupCb,
        view: viewCb,
        manage: manageCb,
      };

      for (const [r, cb] of Object.entries(checkboxes)) {
        if (r === right) {
          expect(cb.checked).toBe(true);
        } else {
          expect(cb.checked).toBe(false);
        }
      }

      fireEvent.click(screen.getByRole("button", { name: "Save minor" }));

      await waitFor(() => {
        expect(postCalls.some((c) => c.path === "/v1/households/members/add-minor")).toBe(true);
      });

      const call = postCalls.find((c) => c.path === "/v1/households/members/add-minor");
      const body = call?.body as { rights?: Record<string, boolean> };
      expect(body.rights).toEqual({
        consent: right === "consent",
        pickup: right === "pickup",
        view: right === "view",
        manage: right === "manage",
      });
    },
  );

  it.each([
    { right: "consent", label: "Consent" },
    { right: "pickup", label: "Pickup" },
    { right: "view", label: "View" },
    { right: "manage", label: "Manage" },
  ] as const)("pins Link Guardian right $right to checkbox $label", async ({ right, label }) => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    sessionStorage.setItem("community-hub.community", SLUG);
    const postCalls: Array<{ path: string; body: unknown }> = [];

    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      onPost: (path, body) => postCalls.push({ path, body }),
    });

    render(
      <PeopleAccessContext.Provider value={{ access: fullAccess }}>
        <CommunityProvider>
          <BillingStatusProvider>
            <MemoryRouter initialEntries={["/family-records"]}>
              <FamilyRecordsPage />
            </MemoryRouter>
          </BillingStatusProvider>
        </CommunityProvider>
      </PeopleAccessContext.Provider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Link guardian" }));
    expect(await screen.findByRole("heading", { name: "Link Guardian" })).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "Guardian" }), {
      target: { value: sampleDetail.adults[0]!.personId },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Child" }), {
      target: { value: sampleDetail.minors![0]!.personId },
    });

    const consentCb = screen.getByRole("checkbox", { name: "Consent" }) as HTMLInputElement;
    const pickupCb = screen.getByRole("checkbox", { name: "Pickup" }) as HTMLInputElement;
    const viewCb = screen.getByRole("checkbox", { name: "View" }) as HTMLInputElement;
    const manageCb = screen.getByRole("checkbox", { name: "Manage" }) as HTMLInputElement;

    // Consent and View are checked by default — uncheck both
    fireEvent.click(consentCb);
    fireEvent.click(viewCb);

    const targetCb = screen.getByRole("checkbox", { name: label });
    fireEvent.click(targetCb);

    const checkboxes = {
      consent: consentCb,
      pickup: pickupCb,
      view: viewCb,
      manage: manageCb,
    };

    for (const [r, cb] of Object.entries(checkboxes)) {
      if (r === right) {
        expect(cb.checked).toBe(true);
      } else {
        expect(cb.checked).toBe(false);
      }
    }

    fireEvent.click(screen.getByRole("button", { name: "Save link" }));

    await waitFor(() => {
      expect(postCalls.some((c) => c.path === "/v1/households/guardians/link")).toBe(true);
    });

    const call = postCalls.find((c) => c.path === "/v1/households/guardians/link");
    const body = call?.body as { rights?: Record<string, boolean> };
    expect(body.rights).toEqual({
      consent: right === "consent",
      pickup: right === "pickup",
      view: right === "view",
      manage: right === "manage",
    });
  });

  it("uses the small size for buttons inside table rows", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    sessionStorage.setItem("community-hub.community", SLUG);

    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult: {
        items: [
          {
            householdId: sampleDetail.householdId,
            version: 1,
            label: sampleDetail.label,
            adultCount: 1,
          },
        ],
        nextCursor: null,
      },
      detailResult: sampleDetail,
      peopleListResult: {
        items: [
          {
            personId: "00000000-0000-4000-8000-000000000099",
            givenName: "Beatrice",
            familyName: "Webb",
            isMinor: false,
            version: 1,
          },
        ],
        nextCursor: null,
      },
    });

    render(
      <PeopleAccessContext.Provider value={{ access: fullAccess }}>
        <CommunityProvider>
          <BillingStatusProvider>
            <MemoryRouter initialEntries={["/family-records"]}>
              <FamilyRecordsPage />
            </MemoryRouter>
          </BillingStatusProvider>
        </CommunityProvider>
      </PeopleAccessContext.Provider>,
    );

    // 1. Households table (list view)
    const householdsTable = await screen.findByRole("table", { name: "Households" });
    const householdButtons = householdsTable.querySelectorAll("button");
    expect(householdButtons.length).toBeGreaterThan(0);
    for (const btn of householdButtons) {
      expect(btn.className).toContain("h-(--ch-size-control-sm)");
    }

    // 2. Detail view: Adult members and Guardian links tables
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));

    const adultTable = await screen.findByRole("table", { name: "Adult members" });
    const adultButtons = adultTable.querySelectorAll("button");
    expect(adultButtons.length).toBeGreaterThan(0);
    for (const btn of adultButtons) {
      expect(btn.className).toContain("h-(--ch-size-control-sm)");
    }

    const guardianTable = await screen.findByRole("table", { name: "Guardian links" });
    const unlinkButtons = guardianTable.querySelectorAll("button");
    expect(unlinkButtons.length).toBeGreaterThan(0);
    for (const btn of unlinkButtons) {
      expect(btn.className).toContain("h-(--ch-size-control-sm)");
    }

    // Open inline confirm in Guardian links table
    fireEvent.click(unlinkButtons[0]!);
    const confirmButtons = guardianTable.querySelectorAll("button");
    expect(confirmButtons.length).toBe(2);
    for (const btn of confirmButtons) {
      expect(btn.className).toContain("h-(--ch-size-control-sm)");
    }

    // 3. Add adult view: Adult search results table
    fireEvent.click(await screen.findByRole("button", { name: "Add adult" }));
    expect(await screen.findByRole("heading", { name: "Add Adult", level: 2 })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search adults" }), {
      target: { value: "Webb" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    const searchTable = await screen.findByRole("table", { name: "Adult search results" });
    const searchButtons = searchTable.querySelectorAll("button");
    expect(searchButtons.length).toBeGreaterThan(0);
    for (const btn of searchButtons) {
      expect(btn.className).toContain("h-(--ch-size-control-sm)");
    }
  });
});

describe("Family Records - Create new adult", () => {
  const sampleDetail = {
    householdId: "00000000-0000-4000-8000-000000000001",
    version: 1,
    label: "Clarke Family",
    adults: [
      {
        personId: "00000000-0000-4000-8000-000000000010",
        givenName: "Arthur",
        familyName: "Clarke",
        version: 1,
      },
    ],
    minors: [],
    guardians: [],
  };

  const listResult = {
    items: [
      {
        householdId: sampleDetail.householdId,
        version: 1,
        label: sampleDetail.label,
        adultCount: 1,
      },
    ],
    nextCursor: null,
  };

  const fullAccess: PeopleAccess = {
    permissions: {
      "people.view": true,
      "people.manage": true,
      "people.restricted.read": true,
      "people.delete": false,
      "service_times.manage": false,
    },
    entitlements: {
      "people.directory": true,
      "people.households": true,
      "module.engagement": false,
    },
  };

  type Recorded = Array<{ path: string; body: unknown }>;

  function addAdultCalls(calls: Recorded): Recorded {
    return calls.filter((c) => c.path === "/v1/households/members/add-adult");
  }

  async function openAddAdultView(options: MockApiOptions = {}): Promise<{
    calls: Recorded;
    container: HTMLElement;
  }> {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const calls: Recorded = [];
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult,
      detailResult: sampleDetail,
      onPost: (path, body) => calls.push({ path, body }),
      ...options,
    });
    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add adult" }));
    expect(await screen.findByRole("heading", { name: "Add Adult" })).toBeTruthy();
    return { calls, container };
  }

  async function openNewAdultForm(options: MockApiOptions = {}) {
    const opened = await openAddAdultView(options);
    fireEvent.click(await screen.findByRole("button", { name: "Create new adult" }));
    expect(
      await screen.findByRole("heading", { name: "New adult in this household" }),
    ).toBeTruthy();
    return opened;
  }

  function fillNames() {
    fireEvent.change(screen.getByLabelText("Given name"), { target: { value: "Beatrice" } });
    fireEvent.change(screen.getByLabelText("Family name"), { target: { value: "Webb" } });
  }

  function save() {
    fireEvent.click(screen.getByRole("button", { name: "Save adult" }));
  }

  it("hides 'Create new adult' when people.manage, people.restricted.read or people.directory is removed", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    sessionStorage.setItem("community-hub.community", SLUG);
    mockApi({
      access: { householdsEnabled: true, canView: true, canManage: true, canReadMinors: true },
      listResult,
      detailResult: sampleDetail,
    });

    function tree(access: PeopleAccess) {
      return (
        <PeopleAccessContext.Provider value={{ access }}>
          <CommunityProvider>
            <BillingStatusProvider>
              <MemoryRouter initialEntries={["/family-records"]}>
                <FamilyRecordsPage />
              </MemoryRouter>
            </BillingStatusProvider>
          </CommunityProvider>
        </PeopleAccessContext.Provider>
      );
    }

    const { rerender } = render(tree(fullAccess));
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add adult" }));
    expect(await screen.findByRole("heading", { name: "Add Adult" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create new adult" })).toBeTruthy();

    const withoutRights: PeopleAccess[] = [
      { ...fullAccess, permissions: { ...fullAccess.permissions, "people.manage": false } },
      {
        ...fullAccess,
        permissions: { ...fullAccess.permissions, "people.restricted.read": false },
      },
      { ...fullAccess, entitlements: { ...fullAccess.entitlements, "people.directory": false } },
    ];
    for (const reduced of withoutRights) {
      rerender(tree(reduced));
      expect(screen.getByRole("heading", { name: "Add Adult" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Create new adult" })).toBeNull();
      rerender(tree(fullAccess));
      expect(screen.getByRole("button", { name: "Create new adult" })).toBeTruthy();
    }
  });

  it("opens Create new adult and returns to the search on Cancel without a request", async () => {
    const { calls } = await openNewAdultForm();

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "New adult in this household" }),
      ),
    );
    expect(screen.queryByRole("textbox", { name: "Search adults" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByRole("heading", { name: "Add Adult" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Search adults" })).toBeTruthy();
    expect(addAdultCalls(calls)).toHaveLength(0);
  });

  it("refuses an under-18 date of birth before sending", async () => {
    const { calls } = await openNewAdultForm();

    fillNames();
    fireEvent.change(screen.getByLabelText("Date of birth"), {
      target: { value: `${new Date().getUTCFullYear() - 10}-06-15` },
    });
    save();

    expect(await screen.findByText("This person is under 18. Use Add minor instead.")).toBeTruthy();
    expect(addAdultCalls(calls)).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "New adult in this household" })).toBeTruthy();
  });

  it("posts add-adult with the household id and omits empty optional fields", async () => {
    const { calls } = await openNewAdultForm();

    fireEvent.change(screen.getByLabelText("Given name"), { target: { value: "  Beatrice " } });
    fireEvent.change(screen.getByLabelText("Family name"), { target: { value: " Webb  " } });
    save();

    await waitFor(() => expect(addAdultCalls(calls)).toHaveLength(1));
    expect(addAdultCalls(calls)[0]!.body).toEqual({
      communitySlug: SLUG,
      householdId: sampleDetail.householdId,
      givenName: "Beatrice",
      familyName: "Webb",
    });

    // Back on Household Details after the 201; a second form with every field filled.
    fireEvent.click(await screen.findByRole("button", { name: "Add adult" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create new adult" }));
    expect(screen.getByLabelText<HTMLInputElement>("Given name").value).toBe("");
    fillNames();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "bea@example.test" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "+61412555138" } });
    fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1985-03-04" } });
    save();

    await waitFor(() => expect(addAdultCalls(calls)).toHaveLength(2));
    expect(addAdultCalls(calls)[1]!.body).toEqual({
      communitySlug: SLUG,
      householdId: sampleDetail.householdId,
      givenName: "Beatrice",
      familyName: "Webb",
      email: "bea@example.test",
      phone: "+61412555138",
      dateOfBirth: "1985-03-04",
    });
  });

  it("adds the new adult and reloads Household Details on 201 with focus on the heading", async () => {
    let detailLoads = 0;
    const { calls } = await openAddAdultView();
    const fetchSpy = vi.mocked(globalThis.fetch);
    const originalImpl = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (info, init) => {
      const path = String(info).replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/households/read") {
        detailLoads++;
        return new Response(
          JSON.stringify({
            ...sampleDetail,
            adults: [
              ...sampleDetail.adults,
              {
                personId: "00000000-0000-4000-8000-000000000066",
                givenName: "Beatrice",
                familyName: "Webb",
                version: 1,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalImpl(info, init);
    });

    fireEvent.click(screen.getByRole("button", { name: "Create new adult" }));
    fillNames();
    save();

    const heading = await screen.findByRole("heading", { name: "Household Details" });
    expect(await screen.findByText("Beatrice")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(detailLoads).toBe(1);
    expect(addAdultCalls(calls)).toHaveLength(1);
  });

  it("shows 'Check the details and try again.' on 400", async () => {
    const { calls } = await openNewAdultForm({ addAdultResult: 400 });

    fillNames();
    save();

    expect(await screen.findByText("Check the details and try again.")).toBeTruthy();
    expect(addAdultCalls(calls)).toHaveLength(1);
    expect(screen.getByLabelText<HTMLInputElement>("Given name").value).toBe("Beatrice");
  });

  it("shows 'Household not found' on 404 with the back button", async () => {
    await openNewAdultForm({ addAdultResult: 404 });

    fillNames();
    save();

    expect(await screen.findByText("Household not found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
    expect(await screen.findByRole("table", { name: "Households" })).toBeTruthy();
  });

  it("does not show Back to list on an under-18 refusal after a 404", async () => {
    const { calls } = await openNewAdultForm({ addAdultResult: 404 });

    fillNames();
    save();
    expect(await screen.findByText("Household not found")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to list" })).toBeTruthy();
    expect(addAdultCalls(calls)).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Date of birth"), {
      target: { value: `${new Date().getUTCFullYear() - 10}-06-15` },
    });
    save();

    expect(await screen.findByText("This person is under 18. Use Add minor instead.")).toBeTruthy();
    expect(screen.queryByText("Household not found")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to list" })).toBeNull();
    expect(addAdultCalls(calls)).toHaveLength(1);
  });

  it("shows the duplicate message on 409 and keeps the entered values", async () => {
    const { calls } = await openNewAdultForm({ addAdultResult: 409 });

    fillNames();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "bea@example.test" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "+61412555138" } });
    fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1985-03-04" } });
    save();

    expect(
      await screen.findByText(
        "A contact with this email or phone already exists. Search for them instead.",
      ),
    ).toBeTruthy();
    expect(addAdultCalls(calls)).toHaveLength(1);
    expect(screen.getByLabelText<HTMLInputElement>("Given name").value).toBe("Beatrice");
    expect(screen.getByLabelText<HTMLInputElement>("Family name").value).toBe("Webb");
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe("bea@example.test");
    expect(screen.getByLabelText<HTMLInputElement>("Phone").value).toBe("+61412555138");
    expect(screen.getByLabelText<HTMLInputElement>("Date of birth").value).toBe("1985-03-04");
  });

  it("shows the generic message on 403, 503, 500 and network failure and keeps the values", async () => {
    const failures: Array<number | "network"> = [403, 503, 500, "network"];
    for (const failure of failures) {
      const { calls } = await openNewAdultForm({ addAdultResult: failure });

      fillNames();
      save();

      expect(await screen.findByText("Unable to add this adult. Try again.")).toBeTruthy();
      expect(addAdultCalls(calls)).toHaveLength(1);
      expect(screen.getByLabelText<HTMLInputElement>("Given name").value).toBe("Beatrice");
      expect(screen.getByLabelText<HTMLInputElement>("Family name").value).toBe("Webb");

      cleanup();
      sessionStorage.clear();
      vi.restoreAllMocks();
      await router.navigate("/");
    }
  });

  it("on 401 sends once, and the screen falls back to sign-in because api.post cleared the token", async () => {
    const { calls } = await openNewAdultForm({ addAdultResult: 401 });

    fillNames();
    save();

    await waitFor(() => expect(addAdultCalls(calls)).toHaveLength(1));
    expect(await screen.findByText("Sign in required")).toBeTruthy();
    expect(sessionStorage.getItem("community-hub.access-token")).toBeNull();
  });

  it("guards Create new adult against double submission", async () => {
    let release: (response: Response) => void = () => {};
    const { calls } = await openNewAdultForm();
    const fetchSpy = vi.mocked(globalThis.fetch);
    const originalImpl = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (info, init) => {
      const path = String(info).replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/households/members/add-adult") {
        const body: unknown = JSON.parse(String(init?.body));
        calls.push({ path, body });
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return originalImpl(info, init);
    });

    fillNames();
    const saveButton = screen.getByRole("button", { name: "Save adult" });
    act(() => {
      fireEvent.click(saveButton);
      fireEvent.click(saveButton);
    });

    await waitFor(() => expect(addAdultCalls(calls)).toHaveLength(1));
    await act(async () => {
      release(
        new Response(JSON.stringify({ personId: "00000000-0000-4000-8000-000000000066" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    await screen.findByRole("heading", { name: "Household Details" });
    expect(addAdultCalls(calls)).toHaveLength(1);
  });

  it("returns to Add Adult with the read-only notice and no Create new adult button after a 402", async () => {
    const { calls } = await openNewAdultForm({ addAdultResult: 402 });

    fillNames();
    save();

    expect(await screen.findByText("Read-only until billing is settled")).toBeTruthy();
    expect(addAdultCalls(calls)).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Add Adult" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "New adult in this household" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create new adult" })).toBeNull();
  });

  it("clears the new adult form on community switch", async () => {
    await openNewAdultForm();

    fillNames();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "bea@example.test" } });

    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: "other-community" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(screen.queryByRole("heading", { name: "New adult in this household" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add adult" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create new adult" }));

    expect(screen.getByLabelText<HTMLInputElement>("Given name").value).toBe("");
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe("");
  });

  it("passes axe scan on the new adult form and ties the date of birth help by aria-describedby", async () => {
    const { container } = await openNewAdultForm();

    const dob = screen.getByLabelText("Date of birth");
    const describedBy = dob.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const help = document.getElementById(describedBy!);
    expect(help?.textContent).toBe("Under 18? Use Add minor instead.");

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);

    fillNames();
    fireEvent.change(dob, { target: { value: `${new Date().getUTCFullYear() - 10}-06-15` } });
    save();
    expect(await screen.findByText("This person is under 18. Use Add minor instead.")).toBeTruthy();
    const after = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(after, "violations")).toEqual([]);
  });

  describe("Family Records parity: add adult source", () => {
    it("Family Records: the add adult form has no Source select", async () => {
      await openNewAdultForm();
      expect(screen.queryByLabelText("Source")).toBeNull();
      expect(screen.queryByRole("combobox", { name: "Source" })).toBeNull();
    });
  });
});

describe("Family Records status, delete and restore (Task 8)", () => {
  const ID_A = "00000000-0000-4000-8000-0000000000c1";
  const ID_B = "00000000-0000-4000-8000-0000000000c2";
  const ID_C = "00000000-0000-4000-8000-0000000000c3";
  const ID_D = "00000000-0000-4000-8000-0000000000c4";
  const ID_E = "00000000-0000-4000-8000-0000000000c5";
  const OTHER_SLUG = "other-parish";
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const LIST = "/v1/households/list";
  const READ = "/v1/households/read";
  const STATUS = "/v1/households/status";
  const DELETE = "/v1/households/delete";
  const RESTORE = "/v1/households/restore";
  const ADD_ADULT = "/v1/households/members/add-adult";
  const UNLINK = "/v1/households/guardians/unlink";

  const MSG_CHANGED = "Someone else changed this family. Reload and try again.";
  const MSG_FAILED = "Unable to save. Try again.";
  const MSG_CHILD = "This family has a child in it, so it can't be deleted.";
  const MSG_NOT_RESTORABLE =
    "This family can't be restored. It may already be restored or deleted permanently.";
  const MSG_DUPLICATE = "A deleted contact has this email (or phone).";
  const MSG_DUPLICATE_RESTORE = `${MSG_DUPLICATE} Restore it from the Deleted filter.`;
  const MSG_OLD_DUPLICATE =
    "A contact with this email or phone already exists. Search for them instead.";

  const ITEM_A = {
    householdId: ID_A,
    version: 3,
    label: "Clarke Family",
    adultCount: 2,
    status: "active",
  };
  const ITEM_B = {
    householdId: ID_B,
    version: 5,
    label: "Webb Family",
    adultCount: 1,
    status: "inactive",
  };
  const ITEM_C = {
    householdId: ID_C,
    version: 2,
    label: "Hart Family",
    adultCount: 1,
    status: "active",
  };
  const ALL = [ITEM_A, ITEM_B, ITEM_C];

  const deletedAt = new Date(Date.now() - 2 * DAY).toISOString();
  const purgeAfter = new Date(Date.now() + 28 * DAY).toISOString();
  const DELETED_D = {
    householdId: ID_D,
    label: "Moss Family",
    adultCount: 1,
    version: 7,
    deletedAt,
    purgeAfter,
  };
  const DELETED_PAST = {
    householdId: ID_E,
    label: "Lowe Family",
    adultCount: 2,
    version: 9,
    deletedAt: new Date(Date.now() - 31 * DAY).toISOString(),
    purgeAfter: new Date(Date.now() - 1 * HOUR).toISOString(),
  };

  type Body = Record<string, unknown>;
  type Call = { path: string; url: string; body: Body };
  type Handler = (body: Body) => Response | Promise<Response>;
  type Options = {
    canDelete?: boolean;
    canManage?: boolean;
    canRestricted?: boolean;
    billing?: "ok" | "read_only" | "loading";
    list?: Handler;
    read?: Handler;
    status?: Handler;
    del?: Handler;
    restore?: Handler;
    addAdult?: Handler;
    unlink?: Handler;
  };

  function json(status: number, value: unknown): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function empty(status: number): Response {
    return new Response(null, { status });
  }

  function networkDown(): Response {
    throw new TypeError("network down");
  }

  function longDate(value: string | number): string {
    return new Intl.DateTimeFormat("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(value));
  }

  function defaultList(body: Body): Response {
    if (body.status === "deleted") {
      return json(200, { items: [DELETED_D], nextCursor: null });
    }
    const items = body.status === undefined ? ALL : ALL.filter((i) => i.status === body.status);
    return json(200, { items, nextCursor: null });
  }

  function detailBody(body: Body) {
    const found = ALL.find((i) => i.householdId === body.householdId);
    return {
      householdId: body.householdId,
      version: found?.version ?? 1,
      status: found?.status ?? "active",
      label: found?.label ?? null,
      adults: [
        {
          personId: "00000000-0000-4000-8000-000000000010",
          givenName: "Arthur",
          familyName: "Clarke",
          version: 1,
        },
      ],
      minors: [],
      guardians: [],
    };
  }

  // A family with a child and a guardian link, so Family Details offers Unlink.
  function guardianDetail(body: Body): Response {
    return json(200, {
      ...detailBody(body),
      minors: [
        {
          personId: "00000000-0000-4000-8000-000000000020",
          givenName: "Mia",
          familyName: "Clarke",
          dateOfBirth: "2015-01-01",
          version: 1,
        },
      ],
      guardians: [
        {
          linkId: "00000000-0000-4000-8000-000000000030",
          guardianId: "00000000-0000-4000-8000-000000000010",
          childId: "00000000-0000-4000-8000-000000000020",
          rights: { consent: true, pickup: false, view: true, manage: false },
        },
      ],
    });
  }

  function defaultRead(body: Body): Response {
    return json(200, detailBody(body));
  }

  function mockFamilyApi(options: Options = {}) {
    const calls: Call[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      let body: Body = {};
      if (init?.body) {
        const parsed: unknown = JSON.parse(String(init.body));
        body = typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
      }
      calls.push({ path, url, body });

      if (path === "/v1/access/capabilities") {
        return json(200, {
          permissions: {
            "people.view": true,
            "people.manage": options.canManage ?? true,
            "people.restricted.read": options.canRestricted ?? true,
            "people.delete": options.canDelete ?? true,
          },
          entitlements: { "people.directory": true, "people.households": true },
        });
      }
      if (path === "/v1/billing/status") {
        if (options.billing === "loading") {
          return new Promise<Response>(() => {});
        }
        return json(200, {
          state: options.billing ?? "ok",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        });
      }
      if (path === LIST) {
        return (options.list ?? defaultList)(body);
      }
      if (path === READ) {
        return (options.read ?? defaultRead)(body);
      }
      if (path === STATUS) {
        return options.status
          ? options.status(body)
          : json(200, {
              householdId: body.householdId,
              version: (body.version as number) + 1,
              status: body.status,
            });
      }
      if (path === DELETE) {
        return options.del
          ? options.del(body)
          : json(200, {
              householdId: body.householdId,
              version: (body.version as number) + 1,
              purgeAfter: new Date(Date.now() + 30 * DAY).toISOString(),
            });
      }
      if (path === RESTORE) {
        return options.restore
          ? options.restore(body)
          : json(200, { householdId: body.householdId, version: (body.version as number) + 1 });
      }
      if (path === UNLINK) {
        return options.unlink ? options.unlink(body) : json(200, {});
      }
      if (path === ADD_ADULT) {
        return options.addAdult
          ? options.addAdult(body)
          : json(201, { personId: "00000000-0000-4000-8000-000000000066" });
      }
      if (path === "/v1/people/life-events/list") {
        return json(200, { items: [] });
      }
      return empty(404);
    });
    return calls;
  }

  function callsTo(calls: Call[], path: string): Call[] {
    return calls.filter((call) => call.path === path);
  }

  async function openScreen(options: Options = {}) {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const calls = mockFamilyApi(options);
    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    await screen.findByRole("table", { name: "Households" });
    return { calls, container };
  }

  async function resetScreen() {
    cleanup();
    sessionStorage.clear();
    vi.restoreAllMocks();
    document.documentElement.removeAttribute("data-theme");
    await router.navigate("/");
  }

  async function flushPending() {
    for (let turn = 0; turn < 3; turn += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  function statusSelect(): HTMLSelectElement {
    return screen.getByRole<HTMLSelectElement>("combobox", { name: "Status" });
  }

  async function showDeleted() {
    fireEvent.change(statusSelect(), { target: { value: "deleted" } });
    await screen.findByText(/^Deleted .*, deleted permanently on /);
  }

  async function openDetail(name: string) {
    fireEvent.click(await screen.findByRole("button", { name: `View ${name}` }));
    await screen.findByText("Arthur");
  }

  async function openDeleteDialog(name: string) {
    await openDetail(name);
    const trigger = await screen.findByRole("button", { name: "Delete family" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    return { trigger, dialog };
  }

  function confirmButton(dialog: HTMLElement): HTMLElement {
    return within(dialog).getByRole("button", { name: "Delete family" });
  }

  async function expectHeadingFocused() {
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Family Records" })),
    );
  }

  async function switchCommunity() {
    // An open Delete dialog is modal and hides the picker from the accessibility tree.
    fireEvent.change(screen.getByRole("textbox", { name: "Community", hidden: true }), {
      target: { value: OTHER_SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set", hidden: true }));
    await screen.findByRole("table", { name: "Households" });
    await flushPending();
  }

  async function expectNoViolations(target: HTMLElement, label: string) {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.dataset.theme = theme;
      const results = await axe.run(target, { rules: { "color-contrast": { enabled: false } } });
      expect(resultIds(results, "violations"), `${label} ${theme}`).toEqual([]);
    }
    document.documentElement.removeAttribute("data-theme");
  }

  function deferred() {
    let release: (response: Response) => void = () => {};
    const promise = new Promise<Response>((resolve) => {
      release = resolve;
    });
    return { promise, release: (response: Response) => release(response) };
  }

  describe("status filter", () => {
    it("the status filter sends status only when a filter is chosen", async () => {
      const { calls } = await openScreen();
      const select = statusSelect();
      expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
        "All",
        "Active",
        "Inactive",
        "Deleted",
      ]);
      expect(callsTo(calls, LIST)).toHaveLength(1);
      expect(callsTo(calls, LIST)[0]!.body).toEqual({ communitySlug: SLUG, limit: 25 });

      fireEvent.change(select, { target: { value: "active" } });
      await waitFor(() => expect(callsTo(calls, LIST)).toHaveLength(2));
      expect(callsTo(calls, LIST)[1]!.body).toEqual({
        communitySlug: SLUG,
        limit: 25,
        status: "active",
      });
      expect(await screen.findByText("Clarke Family")).toBeTruthy();
      expect(screen.queryByText("Webb Family")).toBeNull();

      fireEvent.change(select, { target: { value: "" } });
      await waitFor(() => expect(callsTo(calls, LIST)).toHaveLength(3));
      expect(callsTo(calls, LIST)[2]!.body).toEqual({ communitySlug: SLUG, limit: 25 });
      await flushPending();
      expect(callsTo(calls, LIST)).toHaveLength(3);
    });

    it("the Deleted option is not rendered without all three keys", async () => {
      const cases: Array<{ canDelete: boolean; canRestricted: boolean; offered: boolean }> = [
        { canDelete: true, canRestricted: true, offered: true },
        { canDelete: false, canRestricted: true, offered: false },
        { canDelete: true, canRestricted: false, offered: false },
        { canDelete: false, canRestricted: false, offered: false },
      ];
      for (const { canDelete, canRestricted, offered } of cases) {
        await openScreen({ canDelete, canRestricted });
        const labels = Array.from(statusSelect().options).map((option) => option.textContent);
        expect(labels.includes("Deleted"), `${canDelete} ${canRestricted}`).toBe(offered);
        expect(labels.slice(0, 3)).toEqual(["All", "Active", "Inactive"]);
        await resetScreen();
      }
    });

    it("a missing or unknown status in a list item is read as active", async () => {
      await openScreen({
        list: () =>
          json(200, {
            items: [
              { householdId: ID_A, version: 3, label: "Old Family", adultCount: 1 },
              {
                householdId: ID_B,
                version: 5,
                label: "Odd Family",
                adultCount: 1,
                status: "weird",
              },
            ],
            nextCursor: null,
          }),
      });
      expect(
        screen.getByRole<HTMLInputElement>("switch", { name: "Active status for Old Family" })
          .checked,
      ).toBe(true);
      expect(
        screen.getByRole<HTMLInputElement>("switch", { name: "Active status for Odd Family" })
          .checked,
      ).toBe(true);
    });

    it("a caller without people.manage sees a status badge and no switch", async () => {
      await openScreen({ canManage: false });
      expect(screen.queryAllByRole("switch")).toHaveLength(0);
      const table = screen.getByRole("table", { name: "Households" });
      const badges = Array.from(table.querySelectorAll("[data-slot='status-badge']")).map(
        (badge) => badge.textContent,
      );
      expect(badges).toEqual(["Active", "Inactive", "Active"]);
    });

    it("goes back to All, and never shows deleted rows, when the Deleted filter loses a key", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      sessionStorage.setItem("community-hub.community", SLUG);
      const calls = mockFamilyApi();
      const full: PeopleAccess = {
        permissions: {
          "people.view": true,
          "people.manage": true,
          "people.restricted.read": true,
          "people.delete": true,
          "service_times.manage": false,
        },
        entitlements: {
          "people.directory": true,
          "people.households": true,
          "module.engagement": false,
        },
      };
      function tree(access: PeopleAccess) {
        return (
          <PeopleAccessContext.Provider value={{ access }}>
            <CommunityProvider>
              <BillingStatusProvider>
                <MemoryRouter initialEntries={["/family-records"]}>
                  <FamilyRecordsPage />
                </MemoryRouter>
              </BillingStatusProvider>
            </CommunityProvider>
          </PeopleAccessContext.Provider>
        );
      }

      const view = render(tree(full));
      await screen.findByRole("table", { name: "Households" });
      await showDeleted();
      expect(screen.getByText("Moss Family")).toBeTruthy();
      const before = callsTo(calls, LIST).length;

      for (const lost of ["people.delete", "people.restricted.read"]) {
        view.rerender(tree(full));
        fireEvent.change(statusSelect(), { target: { value: "deleted" } });
        await screen.findByText("Moss Family");
        const sent = callsTo(calls, LIST).length;
        view.rerender(tree({ ...full, permissions: { ...full.permissions, [lost]: false } }));
        await screen.findByText("Clarke Family");
        expect(screen.queryByText("Moss Family"), lost).toBeNull();
        expect(statusSelect().value, lost).toBe("");
        await flushPending();
        const sentAfter = callsTo(calls, LIST).slice(sent);
        expect(sentAfter, lost).toHaveLength(1);
        expect(sentAfter[0]!.body, lost).toEqual({ communitySlug: SLUG, limit: 25 });
      }
      expect(callsTo(calls, LIST).length).toBeGreaterThan(before);
    });

    it("a late list answer of the previous filter is ignored", async () => {
      const late = deferred();
      const { calls } = await openScreen({
        list: (body) => {
          if (body.status === "inactive") {
            return late.promise;
          }
          return defaultList(body);
        },
      });
      fireEvent.change(statusSelect(), { target: { value: "inactive" } });
      await waitFor(() => expect(callsTo(calls, LIST)).toHaveLength(2));
      fireEvent.change(statusSelect(), { target: { value: "active" } });
      await waitFor(() => expect(callsTo(calls, LIST)).toHaveLength(3));
      expect(await screen.findByText("Hart Family")).toBeTruthy();

      await act(async () => {
        late.release(json(200, { items: [ITEM_B], nextCursor: null }));
      });
      await flushPending();
      expect(screen.queryByText("Webb Family")).toBeNull();
      expect(screen.getByText("Clarke Family")).toBeTruthy();
      expect(statusSelect().value).toBe("active");
      expect(callsTo(calls, LIST)).toHaveLength(3);
    });
  });

  describe("status switch", () => {
    it("the status switch has an accessible name with the family name and no name in the URL or title", async () => {
      const { calls } = await openScreen({
        list: () =>
          json(200, {
            items: [ITEM_A, { ...ITEM_B, label: null }],
            nextCursor: null,
          }),
      });
      expect(
        screen.getByRole<HTMLInputElement>("switch", { name: "Active status for Clarke Family" })
          .checked,
      ).toBe(true);
      expect(
        screen.getByRole<HTMLInputElement>("switch", { name: "Inactive status for this family" })
          .checked,
      ).toBe(false);
      expect(document.title).not.toContain("Clarke");
      for (const call of calls) {
        expect(call.url).not.toContain("Clarke");
      }
    });

    it("the status switch is optimistic and marked busy while its own save is open", async () => {
      const save = deferred();
      const { calls } = await openScreen({ status: () => save.promise });
      const own = screen.getByRole<HTMLInputElement>("switch", {
        name: "Active status for Clarke Family",
      });
      const other = screen.getByRole<HTMLInputElement>("switch", {
        name: "Active status for Hart Family",
      });
      fireEvent.click(own);
      expect(own.checked).toBe(false);
      expect(own.getAttribute("aria-disabled")).toBe("true");
      expect(own.getAttribute("aria-busy")).toBe("true");
      expect(own.disabled).toBe(false);
      expect(other.getAttribute("aria-disabled")).toBeNull();
      expect(other.disabled).toBe(false);
      fireEvent.click(own);
      await waitFor(() => expect(callsTo(calls, STATUS)).toHaveLength(1));
      expect(callsTo(calls, STATUS)[0]!.body).toEqual({
        communitySlug: SLUG,
        householdId: ID_A,
        version: 3,
        status: "inactive",
      });

      await act(async () => {
        save.release(json(200, { householdId: ID_A, version: 4, status: "inactive" }));
      });
      await waitFor(() => expect(own.getAttribute("aria-disabled")).toBeNull());
      expect(own.getAttribute("aria-busy")).toBeNull();
      expect(own.checked).toBe(false);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(callsTo(calls, STATUS)).toHaveLength(1);
    });

    it("focus stays on the status switch after a successful change", async () => {
      const save = deferred();
      const { calls } = await openScreen({ status: () => save.promise });
      const own = screen.getByRole<HTMLInputElement>("switch", {
        name: "Active status for Clarke Family",
      });
      own.focus();
      fireEvent.click(own);
      await waitFor(() => expect(callsTo(calls, STATUS)).toHaveLength(1));
      expect(own.getAttribute("aria-disabled")).toBe("true");
      expect(document.activeElement).toBe(own);

      // A second toggle while the save is open, by click or by key, sends nothing.
      fireEvent.click(own);
      fireEvent.keyDown(own, { key: " ", code: "Space" });
      fireEvent.keyUp(own, { key: " ", code: "Space" });
      await flushPending();
      expect(callsTo(calls, STATUS)).toHaveLength(1);
      expect(own.checked).toBe(false);

      await act(async () => {
        save.release(json(200, { householdId: ID_A, version: 4, status: "inactive" }));
      });
      await waitFor(() => expect(own.getAttribute("aria-disabled")).toBeNull());
      expect(document.activeElement).toBe(own);
      expect(own.checked).toBe(false);
      expect(callsTo(calls, STATUS)).toHaveLength(1);
    });

    it("the status switch returns to its stored value when the save fails", async () => {
      const failures: Array<{ name: string; answer: Handler; message: string }> = [
        { name: "409", answer: () => empty(409), message: MSG_CHANGED },
        { name: "500", answer: () => empty(500), message: MSG_FAILED },
        { name: "503", answer: () => empty(503), message: MSG_FAILED },
        { name: "network", answer: networkDown, message: MSG_FAILED },
        { name: "bad body", answer: () => json(200, { nope: true }), message: MSG_FAILED },
      ];
      for (const failure of failures) {
        const { calls } = await openScreen({ status: failure.answer });
        const own = screen.getByRole<HTMLInputElement>("switch", {
          name: "Active status for Clarke Family",
        });
        fireEvent.click(own);
        expect((await screen.findByRole("alert")).textContent, failure.name).toBe(failure.message);
        expect(own.checked, failure.name).toBe(true);
        expect(own.disabled, failure.name).toBe(false);
        expect(callsTo(calls, STATUS), failure.name).toHaveLength(1);
        expect(callsTo(calls, LIST), failure.name).toHaveLength(1);
        await resetScreen();
      }
    });

    it("the status switch uses the version of the last answer", async () => {
      const { calls } = await openScreen();
      const own = screen.getByRole<HTMLInputElement>("switch", {
        name: "Active status for Clarke Family",
      });
      fireEvent.click(own);
      await waitFor(() => expect(callsTo(calls, STATUS)).toHaveLength(1));
      await waitFor(() =>
        expect(
          screen
            .getByRole<HTMLInputElement>("switch", {
              name: "Inactive status for Clarke Family",
            })
            .getAttribute("aria-disabled"),
        ).toBeNull(),
      );
      expect(callsTo(calls, STATUS)[0]!.body.version).toBe(3);

      fireEvent.click(screen.getByRole("switch", { name: "Inactive status for Clarke Family" }));
      await waitFor(() => expect(callsTo(calls, STATUS)).toHaveLength(2));
      expect(callsTo(calls, STATUS)[1]!.body).toEqual({
        communitySlug: SLUG,
        householdId: ID_A,
        version: 4,
        status: "active",
      });
      expect(callsTo(calls, LIST)).toHaveLength(1);
    });

    it("under an Active filter a family that became inactive leaves the list, and focus goes to the heading", async () => {
      const { calls } = await openScreen();
      fireEvent.change(statusSelect(), { target: { value: "active" } });
      await screen.findByText("Hart Family");
      await waitFor(() => expect(callsTo(calls, LIST)).toHaveLength(2));

      fireEvent.click(screen.getByRole("switch", { name: "Active status for Clarke Family" }));
      await waitFor(() => expect(screen.queryByText("Clarke Family")).toBeNull());
      expect(screen.getByText("Hart Family")).toBeTruthy();
      await expectHeadingFocused();
      await flushPending();
      expect(callsTo(calls, LIST)).toHaveLength(2);
    });

    it("a status answer that arrives after the community changed is ignored", async () => {
      const answers: Array<{ name: string; answer: () => Response }> = [
        {
          name: "200",
          answer: () => json(200, { householdId: ID_A, version: 4, status: "inactive" }),
        },
        { name: "409", answer: () => empty(409) },
        { name: "500", answer: () => empty(500) },
      ];
      for (const late of answers) {
        const save = deferred();
        const { calls } = await openScreen({ status: () => save.promise });
        fireEvent.click(screen.getByRole("switch", { name: "Active status for Clarke Family" }));
        await waitFor(() => expect(callsTo(calls, STATUS)).toHaveLength(1));

        await switchCommunity();
        const listBefore = callsTo(calls, LIST).length;
        await act(async () => {
          save.release(late.answer());
        });
        await flushPending();
        expect(screen.queryByRole("alert"), late.name).toBeNull();
        const own = screen.getByRole<HTMLInputElement>("switch", {
          name: "Active status for Clarke Family",
        });
        expect(own.checked, late.name).toBe(true);
        expect(own.disabled, late.name).toBe(false);
        expect(callsTo(calls, LIST), late.name).toHaveLength(listBefore);
        expect(callsTo(calls, STATUS), late.name).toHaveLength(1);
        await resetScreen();
      }
    });

    it("an answer for the open family updates its version and status in Family Details", async () => {
      const save = deferred();
      const { calls } = await openScreen({ status: () => save.promise });
      fireEvent.click(screen.getByRole("switch", { name: "Active status for Clarke Family" }));
      await waitFor(() => expect(callsTo(calls, STATUS)).toHaveLength(1));
      await openDetail("Clarke Family");
      expect(screen.getByText("Active", { selector: "[data-slot='status-badge']" })).toBeTruthy();

      await act(async () => {
        save.release(json(200, { householdId: ID_A, version: 4, status: "inactive" }));
      });
      expect(
        await screen.findByText("Inactive", { selector: "[data-slot='status-badge']" }),
      ).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Rename household" }));
      fireEvent.change(await screen.findByLabelText("Household name"), {
        target: { value: "Clarke Household" },
      });
      const renames: Body[] = [];
      const fetchSpy = vi.mocked(globalThis.fetch);
      const original = fetchSpy.getMockImplementation()!;
      fetchSpy.mockImplementation(async (info, init) => {
        if (String(info).endsWith("/v1/households/rename")) {
          renames.push(JSON.parse(String(init?.body)) as Body);
          return json(200, { version: 5 });
        }
        return original(info, init);
      });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(renames).toHaveLength(1));
      expect(renames[0]!.version).toBe(4);
    });
  });

  describe("read-only community", () => {
    it("a read-only community renders no status switch, Delete or Restore", async () => {
      for (const billing of ["read_only", "loading"] as const) {
        await openScreen({ billing });
        expect(screen.queryAllByRole("switch"), billing).toHaveLength(0);
        const table = screen.getByRole("table", { name: "Households" });
        expect(table.querySelectorAll("[data-slot='status-badge']"), billing).toHaveLength(3);

        // The filter and the lists still work.
        await showDeleted();
        expect(screen.getByText("Moss Family")).toBeTruthy();
        expect(screen.queryByRole("button", { name: /^Restore/ }), billing).toBeNull();

        fireEvent.change(statusSelect(), { target: { value: "" } });
        await openDetail("Clarke Family");
        expect(screen.queryByRole("button", { name: "Delete family" }), billing).toBeNull();
        await resetScreen();
      }
    });
  });

  describe("Delete family", () => {
    it("Delete family is not rendered without all three keys", async () => {
      const cases: Array<{ canDelete: boolean; canRestricted: boolean; shown: boolean }> = [
        { canDelete: false, canRestricted: true, shown: false },
        { canDelete: true, canRestricted: false, shown: false },
        { canDelete: false, canRestricted: false, shown: false },
        { canDelete: true, canRestricted: true, shown: true },
      ];
      for (const { canDelete, canRestricted, shown } of cases) {
        await openScreen({ canDelete, canRestricted });
        await openDetail("Clarke Family");
        expect(
          screen.queryByRole("button", { name: "Delete family" }) !== null,
          `${canDelete} ${canRestricted}`,
        ).toBe(shown);
        await resetScreen();
      }
    });

    it("the Delete dialog names the family and the date 720 hours from now", async () => {
      await openScreen();
      const before = longDate(Date.now() + 720 * HOUR);
      const { dialog } = await openDeleteDialog("Clarke Family");
      const after = longDate(Date.now() + 720 * HOUR);
      expect(within(dialog).getByText("Delete Clarke Family?")).toBeTruthy();
      const text = (date: string) =>
        `It is hidden now and deleted permanently on ${date}. Its adults stay in All Contacts. Staff with the delete and restricted read permissions can restore it until then.`;
      const description = within(dialog).getByText(
        /^It is hidden now and deleted permanently on /,
      ).textContent;
      expect([text(before), text(after)]).toContain(description);
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
      expect(confirmButton(dialog)).toBeTruthy();
    });

    it("a family without a name reads this family in the dialog", async () => {
      await openScreen({
        list: () => json(200, { items: [{ ...ITEM_A, label: null }], nextCursor: null }),
        read: (body) => json(200, { ...detailBody(body), label: null }),
      });
      fireEvent.click(await screen.findByRole("button", { name: "View household" }));
      await screen.findByText("Arthur");
      fireEvent.click(await screen.findByRole("button", { name: "Delete family" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Delete this family?")).toBeTruthy();
    });

    it("confirming sends the version of the open family and closes the panel, reloads the list once and focuses the heading", async () => {
      const { calls } = await openScreen();
      const { dialog } = await openDeleteDialog("Clarke Family");
      const listBefore = callsTo(calls, LIST).length;
      const readBefore = callsTo(calls, READ).length;
      fireEvent.click(confirmButton(dialog));

      await waitFor(() => expect(callsTo(calls, DELETE)).toHaveLength(1));
      expect(callsTo(calls, DELETE)[0]!.body).toEqual({
        communitySlug: SLUG,
        householdId: ID_A,
        version: 3,
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(await screen.findByRole("table", { name: "Households" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Household Details" })).toBeNull();
      await expectHeadingFocused();
      await flushPending();
      expect(callsTo(calls, LIST)).toHaveLength(listBefore + 1);
      expect(callsTo(calls, READ)).toHaveLength(readBefore);
      expect(callsTo(calls, DELETE)).toHaveLength(1);
    });

    it("the dialog cannot be confirmed twice or closed while the request is open", async () => {
      const save = deferred();
      const { calls } = await openScreen({ del: () => save.promise });
      const { dialog } = await openDeleteDialog("Clarke Family");
      const confirm = confirmButton(dialog);
      act(() => {
        fireEvent.click(confirm);
        fireEvent.click(confirm);
      });
      await waitFor(() => expect(callsTo(calls, DELETE)).toHaveLength(1));
      fireEvent.click(confirm);

      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      fireEvent.keyDown(dialog, { key: "Escape" });
      await flushPending();
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(callsTo(calls, DELETE)).toHaveLength(1);

      await act(async () => {
        save.release(
          json(200, { householdId: ID_A, version: 4, purgeAfter: new Date().toISOString() }),
        );
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(callsTo(calls, DELETE)).toHaveLength(1);
    });

    it("a family with a child shows its refusal in the dialog", async () => {
      const { calls } = await openScreen({
        del: () => json(409, { code: "household_has_children" }),
      });
      const { dialog } = await openDeleteDialog("Clarke Family");
      fireEvent.click(confirmButton(dialog));

      expect((await within(dialog).findByRole("alert")).textContent).toBe(MSG_CHILD);
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(within(dialog).queryByText(MSG_CHANGED)).toBeNull();
      expect(callsTo(calls, DELETE)).toHaveLength(1);
      expect(callsTo(calls, LIST)).toHaveLength(1);
      expect(screen.getByRole("heading", { name: "Household Details", hidden: true })).toBeTruthy();
    });

    it("the other refusals stay in the dialog with their own text", async () => {
      const cases: Array<{ name: string; answer: Handler; message: string }> = [
        { name: "409 without a code", answer: () => empty(409), message: MSG_CHANGED },
        {
          name: "409 with an unknown code",
          answer: () => json(409, { code: "something_else" }),
          message: MSG_CHANGED,
        },
        { name: "network", answer: networkDown, message: MSG_FAILED },
        { name: "500", answer: () => empty(500), message: MSG_FAILED },
        { name: "403", answer: () => empty(403), message: MSG_FAILED },
      ];
      for (const refusal of cases) {
        const { calls } = await openScreen({ del: refusal.answer });
        const { dialog } = await openDeleteDialog("Clarke Family");
        fireEvent.click(confirmButton(dialog));
        expect((await within(dialog).findByRole("alert")).textContent, refusal.name).toBe(
          refusal.message,
        );
        expect(screen.getByRole("dialog"), refusal.name).toBe(dialog);
        expect(callsTo(calls, DELETE), refusal.name).toHaveLength(1);
        expect(callsTo(calls, LIST), refusal.name).toHaveLength(1);
        await resetScreen();
      }
    });

    it("a 404 closes the dialog and the panel and reloads the list", async () => {
      const { calls } = await openScreen({ del: () => empty(404) });
      const { dialog } = await openDeleteDialog("Clarke Family");
      const listBefore = callsTo(calls, LIST).length;
      fireEvent.click(confirmButton(dialog));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(await screen.findByRole("table", { name: "Households" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Household Details" })).toBeNull();
      await waitFor(() => expect(callsTo(calls, LIST)).toHaveLength(listBefore + 1));
      await expectHeadingFocused();
      await flushPending();
      expect(callsTo(calls, LIST)).toHaveLength(listBefore + 1);
    });

    it("focus stays in the dialog after a refusal", async () => {
      await openScreen({ del: () => json(409, { code: "household_has_children" }) });
      const { dialog } = await openDeleteDialog("Clarke Family");
      const confirm = confirmButton(dialog);
      confirm.focus();
      fireEvent.click(confirm);

      await within(dialog).findByText(MSG_CHILD);
      await flushPending();
      const active = document.activeElement;
      expect(active).not.toBe(document.body);
      expect(dialog.contains(active)).toBe(true);
      expect(active?.tagName).toBe("BUTTON");
      expect(active?.getAttribute("aria-disabled")).not.toBe("true");
      expect((active as HTMLButtonElement).disabled).toBe(false);
    });

    it("Cancel returns focus to the Delete family button, also after a refusal", async () => {
      await openScreen({ del: () => json(409, { code: "household_has_children" }) });
      const { trigger, dialog } = await openDeleteDialog("Clarke Family");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));

      trigger.focus();
      fireEvent.click(trigger);
      const second = await screen.findByRole("dialog");
      fireEvent.click(confirmButton(second));
      await within(second).findByText(MSG_CHILD);
      fireEvent.click(within(second).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(screen.getByRole("button", { name: "Delete family" })).toBe(trigger);
    });

    it("a late delete answer after a community change is ignored", async () => {
      const answers: Array<{ name: string; answer: () => Response }> = [
        {
          name: "200",
          answer: () =>
            json(200, { householdId: ID_A, version: 4, purgeAfter: new Date().toISOString() }),
        },
        { name: "404", answer: () => empty(404) },
        { name: "409", answer: () => json(409, { code: "household_has_children" }) },
      ];
      for (const late of answers) {
        const save = deferred();
        const { calls } = await openScreen({ del: () => save.promise });
        const { dialog } = await openDeleteDialog("Clarke Family");
        fireEvent.click(confirmButton(dialog));
        await waitFor(() => expect(callsTo(calls, DELETE)).toHaveLength(1));

        await switchCommunity();
        expect(screen.queryByRole("dialog"), late.name).toBeNull();
        const listBefore = callsTo(calls, LIST).length;
        await act(async () => {
          save.release(late.answer());
        });
        await flushPending();
        expect(callsTo(calls, LIST), late.name).toHaveLength(listBefore);
        expect(screen.queryByRole("alert"), late.name).toBeNull();
        expect(screen.queryByRole("dialog"), late.name).toBeNull();
        expect(screen.getByRole("table", { name: "Households" }), late.name).toBeTruthy();
        expect(callsTo(calls, DELETE), late.name).toHaveLength(1);
        await resetScreen();
      }
    });
  });

  describe("Deleted list", () => {
    it("the Deleted list shows the label, both dates and Restore, with no View, no switch and no link", async () => {
      const { calls } = await openScreen();
      await showDeleted();
      expect(callsTo(calls, LIST)[1]!.body).toEqual({
        communitySlug: SLUG,
        limit: 25,
        status: "deleted",
      });
      const table = screen.getByRole("table", { name: "Households" });
      expect(within(table).getByText("Moss Family")).toBeTruthy();
      expect(
        within(table).getByText(
          `Deleted ${longDate(deletedAt)}, deleted permanently on ${longDate(purgeAfter)}`,
        ),
      ).toBeTruthy();
      expect(within(table).getByRole("button", { name: "Restore Moss Family" })).toBeTruthy();
      expect(within(table).queryByRole("button", { name: /^View/ })).toBeNull();
      expect(within(table).queryAllByRole("switch")).toHaveLength(0);
      expect(within(table).queryAllByRole("link")).toHaveLength(0);
      expect(callsTo(calls, READ)).toHaveLength(0);
    });

    it("a deleted family past its date shows pending and no Restore", async () => {
      await openScreen({
        list: (body) =>
          body.status === "deleted"
            ? json(200, { items: [DELETED_D, DELETED_PAST], nextCursor: null })
            : defaultList(body),
      });
      fireEvent.change(statusSelect(), { target: { value: "deleted" } });
      await screen.findByText("Lowe Family");
      expect(screen.getByText("Permanent deletion pending")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Restore Lowe Family" })).toBeNull();
      expect(screen.getByRole("button", { name: "Restore Moss Family" })).toBeTruthy();
    });

    it("the Deleted list shows No deleted families. when it is empty", async () => {
      await openScreen({
        list: (body) =>
          body.status === "deleted"
            ? json(200, { items: [], nextCursor: null })
            : defaultList(body),
      });
      fireEvent.change(statusSelect(), { target: { value: "deleted" } });
      expect(await screen.findByText("No deleted families.")).toBeTruthy();
      expect(screen.queryByText("No households yet")).toBeNull();
    });

    it("a malformed deleted item is dropped", async () => {
      await openScreen({
        list: (body) =>
          body.status === "deleted"
            ? json(200, {
                items: [
                  DELETED_D,
                  { householdId: ID_E, label: "No Dates Family", version: 1 },
                  {
                    householdId: ID_B,
                    label: "Bad Date Family",
                    version: 1,
                    deletedAt: "x",
                    purgeAfter: "y",
                  },
                  { label: "No Id Family", version: 1, deletedAt, purgeAfter },
                  "nonsense",
                ],
                nextCursor: null,
              })
            : defaultList(body),
      });
      fireEvent.change(statusSelect(), { target: { value: "deleted" } });
      await screen.findByText("Moss Family");
      expect(screen.queryByText("No Dates Family")).toBeNull();
      expect(screen.queryByText("Bad Date Family")).toBeNull();
      expect(screen.queryByText("No Id Family")).toBeNull();
      expect(screen.getAllByRole("button", { name: /^Restore/ })).toHaveLength(1);
    });

    it("the Deleted list pages with its own cursor", async () => {
      const { calls } = await openScreen({
        list: (body) => {
          if (body.status === "deleted") {
            return body.cursor === "deleted-cursor-1"
              ? json(200, {
                  items: [{ ...DELETED_D, householdId: ID_E, label: "Page Two Family" }],
                  nextCursor: null,
                })
              : json(200, { items: [DELETED_D], nextCursor: "deleted-cursor-1" });
          }
          return json(200, { items: ALL, nextCursor: "live-cursor-1" });
        },
      });
      fireEvent.change(statusSelect(), { target: { value: "deleted" } });
      await screen.findByText("Moss Family");
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      await screen.findByText("Page Two Family");
      expect(callsTo(calls, LIST).at(-1)!.body).toEqual({
        communitySlug: SLUG,
        limit: 25,
        status: "deleted",
        cursor: "deleted-cursor-1",
      });

      fireEvent.change(statusSelect(), { target: { value: "" } });
      await screen.findByText("Clarke Family");
      expect(callsTo(calls, LIST).at(-1)!.body).toEqual({ communitySlug: SLUG, limit: 25 });
      fireEvent.change(statusSelect(), { target: { value: "deleted" } });
      await screen.findByText("Moss Family");
      expect(callsTo(calls, LIST).at(-1)!.body).toEqual({
        communitySlug: SLUG,
        limit: 25,
        status: "deleted",
      });
    });
  });

  describe("Restore", () => {
    it("Restore sends the version, reloads the list once and focuses the heading", async () => {
      let deletedLoads = 0;
      const { calls } = await openScreen({
        list: (body) => {
          if (body.status === "deleted") {
            deletedLoads += 1;
            return json(200, { items: deletedLoads === 1 ? [DELETED_D] : [], nextCursor: null });
          }
          return defaultList(body);
        },
      });
      await showDeleted();
      const listBefore = callsTo(calls, LIST).length;
      fireEvent.click(screen.getByRole("button", { name: "Restore Moss Family" }));

      expect(await screen.findByText("No deleted families.")).toBeTruthy();
      expect(callsTo(calls, RESTORE)).toHaveLength(1);
      expect(callsTo(calls, RESTORE)[0]!.body).toEqual({
        communitySlug: SLUG,
        householdId: ID_D,
        version: 7,
      });
      await expectHeadingFocused();
      await flushPending();
      expect(callsTo(calls, LIST)).toHaveLength(listBefore + 1);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("Restore is disabled while its own request is open and sends once", async () => {
      const save = deferred();
      const { calls } = await openScreen({ restore: () => save.promise });
      await showDeleted();
      const restore = screen.getByRole<HTMLButtonElement>("button", {
        name: "Restore Moss Family",
      });
      act(() => {
        fireEvent.click(restore);
        fireEvent.click(restore);
      });
      await waitFor(() => expect(callsTo(calls, RESTORE)).toHaveLength(1));
      expect(restore.disabled).toBe(true);
      await act(async () => {
        save.release(json(200, { householdId: ID_D, version: 8 }));
      });
      await flushPending();
      expect(callsTo(calls, RESTORE)).toHaveLength(1);
    });

    it("a restore that answers 404 shows its message and reloads the list", async () => {
      let deletedLoads = 0;
      const { calls } = await openScreen({
        list: (body) => {
          if (body.status === "deleted") {
            deletedLoads += 1;
            return json(200, { items: deletedLoads === 1 ? [DELETED_D] : [], nextCursor: null });
          }
          return defaultList(body);
        },
        restore: () => empty(404),
      });
      await showDeleted();
      const listBefore = callsTo(calls, LIST).length;
      fireEvent.click(screen.getByRole("button", { name: "Restore Moss Family" }));

      expect(await screen.findByText(MSG_NOT_RESTORABLE)).toBeTruthy();
      await waitFor(() => expect(callsTo(calls, LIST)).toHaveLength(listBefore + 1));
      await waitFor(() => expect(screen.queryByText("Moss Family")).toBeNull());
      expect(await screen.findByText("No deleted families.")).toBeTruthy();
      await expectHeadingFocused();
      await flushPending();
      expect(callsTo(calls, LIST)).toHaveLength(listBefore + 1);
      expect(callsTo(calls, RESTORE)).toHaveLength(1);
    });

    it("a restore refused with 409 or failing keeps the row and says why", async () => {
      const cases: Array<{ name: string; answer: Handler; message: string }> = [
        { name: "409", answer: () => empty(409), message: MSG_CHANGED },
        { name: "network", answer: networkDown, message: MSG_FAILED },
        { name: "500", answer: () => empty(500), message: MSG_FAILED },
      ];
      for (const failure of cases) {
        const { calls } = await openScreen({ restore: failure.answer });
        await showDeleted();
        const listBefore = callsTo(calls, LIST).length;
        fireEvent.click(screen.getByRole("button", { name: "Restore Moss Family" }));
        expect((await screen.findByRole("alert")).textContent, failure.name).toBe(failure.message);
        const restore = screen.getByRole<HTMLButtonElement>("button", {
          name: "Restore Moss Family",
        });
        expect(restore.disabled, failure.name).toBe(false);
        expect(callsTo(calls, RESTORE), failure.name).toHaveLength(1);
        expect(callsTo(calls, LIST), failure.name).toHaveLength(listBefore);
        await resetScreen();
      }
    });

    it("a restore answer that arrives after the community changed is ignored", async () => {
      const answers: Array<{ name: string; answer: () => Response }> = [
        { name: "200", answer: () => json(200, { householdId: ID_D, version: 8 }) },
        { name: "404", answer: () => empty(404) },
        { name: "409", answer: () => empty(409) },
      ];
      for (const late of answers) {
        const save = deferred();
        const { calls } = await openScreen({ restore: () => save.promise });
        await showDeleted();
        fireEvent.click(screen.getByRole("button", { name: "Restore Moss Family" }));
        await waitFor(() => expect(callsTo(calls, RESTORE)).toHaveLength(1));

        await switchCommunity();
        const listBefore = callsTo(calls, LIST).length;
        await act(async () => {
          save.release(late.answer());
        });
        await flushPending();
        expect(callsTo(calls, LIST), late.name).toHaveLength(listBefore);
        expect(screen.queryByRole("alert"), late.name).toBeNull();
        expect(callsTo(calls, RESTORE), late.name).toHaveLength(1);
        await resetScreen();
      }
    });
  });

  describe("Add Adult", () => {
    async function submitNewAdult() {
      await openDetail("Clarke Family");
      fireEvent.click(await screen.findByRole("button", { name: "Add adult" }));
      fireEvent.click(await screen.findByRole("button", { name: "Create new adult" }));
      fireEvent.change(await screen.findByLabelText("Given name"), {
        target: { value: "Beatrice" },
      });
      fireEvent.change(screen.getByLabelText("Family name"), { target: { value: "Webb" } });
      fireEvent.click(screen.getByRole("button", { name: "Save adult" }));
    }

    it("Add Adult names a deleted duplicate and keeps the old message for a visible one", async () => {
      for (const canDelete of [true, false]) {
        await openScreen({ canDelete, addAdult: () => json(409, { code: "duplicate_deleted" }) });
        await submitNewAdult();
        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toBe(canDelete ? MSG_DUPLICATE_RESTORE : MSG_DUPLICATE);
        await resetScreen();
      }

      for (const answer of [
        () => empty(409),
        () => json(409, { code: "something_else" }),
        () => new Response("not json", { status: 409 }),
      ]) {
        await openScreen({ addAdult: answer });
        await submitNewAdult();
        expect((await screen.findByRole("alert")).textContent).toBe(MSG_OLD_DUPLICATE);
        expect(screen.getByLabelText<HTMLInputElement>("Given name").value).toBe("Beatrice");
        await resetScreen();
      }
    });
  });

  describe("late answers and reloads", () => {
    async function startUnlink(calls: Call[]) {
      await openDetail("Clarke Family");
      fireEvent.click(
        await screen.findByRole("button", { name: "Unlink Arthur Clarke from Mia Clarke" }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Confirm unlink" }));
      await waitFor(() => expect(callsTo(calls, UNLINK)).toHaveLength(1));
    }

    it("a detail reload while a delete is open does not lose its answer", async () => {
      for (const outcome of ["200", "409"] as const) {
        const unlink = deferred();
        const save = deferred();
        const { calls } = await openScreen({
          read: (body) => guardianDetail(body),
          unlink: () => unlink.promise,
          del: () => save.promise,
        });
        await startUnlink(calls);
        const trigger = await screen.findByRole("button", { name: "Delete family" });
        trigger.focus();
        fireEvent.click(trigger);
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(confirmButton(dialog));
        await waitFor(() => expect(callsTo(calls, DELETE)).toHaveLength(1));

        // The unlink answers while the delete is open: the detail reloads.
        const readsBefore = callsTo(calls, READ).length;
        await act(async () => {
          unlink.release(json(200, {}));
        });
        await waitFor(() => expect(callsTo(calls, READ)).toHaveLength(readsBefore + 1));
        const listBefore = callsTo(calls, LIST).length;

        if (outcome === "200") {
          await act(async () => {
            save.release(
              json(200, { householdId: ID_A, version: 4, purgeAfter: new Date().toISOString() }),
            );
          });
          await waitFor(() => expect(screen.queryByRole("dialog"), outcome).toBeNull());
          expect(await screen.findByRole("table", { name: "Households" })).toBeTruthy();
          expect(screen.queryByRole("heading", { name: "Household Details" })).toBeNull();
          await waitFor(() => expect(callsTo(calls, LIST), outcome).toHaveLength(listBefore + 1));
          await expectHeadingFocused();
          await flushPending();
          expect(callsTo(calls, LIST), outcome).toHaveLength(listBefore + 1);
        } else {
          await act(async () => {
            save.release(json(409, { code: "household_has_children" }));
          });
          expect((await within(dialog).findByRole("alert")).textContent).toBe(MSG_CHILD);
          fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
          await waitFor(() => expect(screen.queryByRole("dialog"), outcome).toBeNull());
          expect(callsTo(calls, LIST), outcome).toHaveLength(listBefore);
        }
        expect(callsTo(calls, DELETE), outcome).toHaveLength(1);
        await resetScreen();
      }
    });

    it("a restore that answers after a page change reloads the page on screen", async () => {
      const save = deferred();
      const { calls } = await openScreen({
        list: (body) => {
          if (body.status === "deleted") {
            return body.cursor === "deleted-cursor-1"
              ? json(200, {
                  items: [{ ...DELETED_D, householdId: ID_E, label: "Page Two Family" }],
                  nextCursor: null,
                })
              : json(200, { items: [DELETED_D], nextCursor: "deleted-cursor-1" });
          }
          return defaultList(body);
        },
        restore: () => save.promise,
      });
      fireEvent.change(statusSelect(), { target: { value: "deleted" } });
      await screen.findByText("Moss Family");
      fireEvent.click(screen.getByRole("button", { name: "Restore Moss Family" }));
      await waitFor(() => expect(callsTo(calls, RESTORE)).toHaveLength(1));

      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      await screen.findByText("Page Two Family");
      const listBefore = callsTo(calls, LIST).length;
      expect(callsTo(calls, LIST).at(-1)!.body).toEqual({
        communitySlug: SLUG,
        limit: 25,
        status: "deleted",
        cursor: "deleted-cursor-1",
      });

      await act(async () => {
        save.release(json(200, { householdId: ID_D, version: 8 }));
      });
      await waitFor(() => expect(callsTo(calls, LIST)).toHaveLength(listBefore + 1));
      expect(callsTo(calls, LIST).at(-1)!.body).toEqual({
        communitySlug: SLUG,
        limit: 25,
        status: "deleted",
        cursor: "deleted-cursor-1",
      });
      await flushPending();
      expect(callsTo(calls, LIST)).toHaveLength(listBefore + 1);
      expect(screen.getByText("Page Two Family")).toBeTruthy();
      expect(screen.queryByText("Moss Family")).toBeNull();
    });

    it("a status answer after a filter change reloads the list once", async () => {
      const save = deferred();
      const { calls } = await openScreen({ status: () => save.promise });
      fireEvent.click(screen.getByRole("switch", { name: "Active status for Clarke Family" }));
      await waitFor(() => expect(callsTo(calls, STATUS)).toHaveLength(1));
      fireEvent.change(statusSelect(), { target: { value: "active" } });
      await screen.findByText("Hart Family");
      await waitFor(() => expect(callsTo(calls, LIST)).toHaveLength(2));

      await act(async () => {
        save.release(json(200, { householdId: ID_A, version: 4, status: "inactive" }));
      });
      await waitFor(() => expect(callsTo(calls, LIST)).toHaveLength(3));
      expect(callsTo(calls, LIST)[2]!.body).toEqual({
        communitySlug: SLUG,
        limit: 25,
        status: "active",
      });
      await flushPending();
      expect(callsTo(calls, LIST)).toHaveLength(3);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(callsTo(calls, STATUS)).toHaveLength(1);
    });
  });

  describe("focus and permissions kept in step (A3)", () => {
    const MSG_READ_ONLY = "Read-only until billing is settled";
    const FULL_ACCESS: PeopleAccess = {
      permissions: {
        "people.view": true,
        "people.manage": true,
        "people.restricted.read": true,
        "people.delete": true,
        "service_times.manage": false,
      },
      entitlements: {
        "people.directory": true,
        "people.households": true,
        "module.engagement": false,
      },
    };
    function accessTree(access: PeopleAccess) {
      return (
        <PeopleAccessContext.Provider value={{ access }}>
          <CommunityProvider>
            <BillingStatusProvider>
              <MemoryRouter initialEntries={["/family-records"]}>
                <FamilyRecordsPage />
              </MemoryRouter>
            </BillingStatusProvider>
          </CommunityProvider>
        </PeopleAccessContext.Provider>
      );
    }
    function withoutKey(key: string): PeopleAccess {
      return { ...FULL_ACCESS, permissions: { ...FULL_ACCESS.permissions, [key]: false } };
    }
    function alertWith(message: string): HTMLElement | undefined {
      return screen.getAllByRole("alert").find((element) => element.textContent === message);
    }

    it("focus goes to the alert after a refused status change or restore", async () => {
      const refusals: Array<{ name: string; answer: Handler; message: string }> = [
        { name: "409", answer: () => empty(409), message: MSG_CHANGED },
        { name: "500", answer: () => empty(500), message: MSG_FAILED },
        { name: "network", answer: networkDown, message: MSG_FAILED },
        { name: "402", answer: () => empty(402), message: MSG_READ_ONLY },
      ];
      for (const action of ["status", "restore"] as const) {
        for (const refusal of refusals) {
          const label = `${action} ${refusal.name}`;
          await openScreen(
            action === "status" ? { status: refusal.answer } : { restore: refusal.answer },
          );
          if (action === "status") {
            fireEvent.click(
              screen.getByRole("switch", { name: "Active status for Clarke Family" }),
            );
          } else {
            await showDeleted();
            fireEvent.click(screen.getByRole("button", { name: "Restore Moss Family" }));
          }
          await waitFor(() => expect(alertWith(refusal.message), label).toBeTruthy());
          const alert = alertWith(refusal.message)!;
          await waitFor(() => expect(document.activeElement, label).toBe(alert));
          expect(alert.getAttribute("tabindex"), label).toBe("-1");
          await resetScreen();
        }
      }
    });

    it("the Delete dialog closes when a key or write access is lost", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      sessionStorage.setItem("community-hub.community", SLUG);
      const calls = mockFamilyApi();
      for (const lost of ["people.delete", "people.restricted.read"]) {
        const view = render(accessTree(FULL_ACCESS));
        await screen.findByRole("table", { name: "Households" });
        await openDetail("Clarke Family");
        const trigger = await screen.findByRole("button", { name: "Delete family" });
        trigger.focus();
        fireEvent.click(trigger);
        await screen.findByRole("dialog");
        const deletes = callsTo(calls, DELETE).length;

        view.rerender(accessTree(withoutKey(lost)));
        await waitFor(() => expect(screen.queryByRole("dialog"), lost).toBeNull());
        expect(screen.queryByRole("button", { name: "Delete family" }), lost).toBeNull();
        await waitFor(() =>
          expect(document.activeElement, lost).toBe(
            screen.getByRole("heading", { name: "Household Details" }),
          ),
        );
        await flushPending();
        expect(callsTo(calls, DELETE), lost).toHaveLength(deletes);
        view.unmount();
      }
      await resetScreen();

      // Write access lost: the delete itself answers 402. The request is sent once, and the dialog
      // closes with the screen's read-only message.
      const { calls: writeCalls } = await openScreen({ del: () => empty(402) });
      const { dialog } = await openDeleteDialog("Clarke Family");
      fireEvent.click(confirmButton(dialog));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await screen.findByText(MSG_READ_ONLY);
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("heading", { name: "Household Details" }),
        ),
      );
      await flushPending();
      expect(callsTo(writeCalls, DELETE)).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "Delete family" })).toBeNull();
    });

    it("no deleted row renders after the Deleted filter loses a key", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      sessionStorage.setItem("community-hub.community", SLUG);
      const reload = deferred();
      let hold = false;
      mockFamilyApi({
        list: (body) => {
          if (body.status === "deleted") {
            return json(200, { items: [DELETED_D], nextCursor: null });
          }
          return hold ? reload.promise : defaultList(body);
        },
      });
      const view = render(accessTree(FULL_ACCESS));
      await screen.findByRole("table", { name: "Households" });
      await showDeleted();
      expect(screen.getByText("Moss Family")).toBeTruthy();
      hold = true;

      view.rerender(accessTree(withoutKey("people.delete")));
      await waitFor(() => expect(statusSelect().value).toBe(""));
      await flushPending();
      // The list reload is still open: nothing of the deleted list may be on screen.
      expect(screen.queryByText("Moss Family")).toBeNull();
      expect(screen.queryByText(/deleted permanently on/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Restore Moss Family" })).toBeNull();
      expect(screen.queryByRole("columnheader", { name: "Deleted" })).toBeNull();

      await act(async () => {
        reload.release(json(200, { items: ALL, nextCursor: null }));
      });
      await screen.findByText("Clarke Family");
      expect(screen.queryByText("Moss Family")).toBeNull();
    });
  });

  describe("accessibility", () => {
    it("has no axe violations in the list with switches, without people.manage and in the read-only community", async () => {
      const full = await openScreen();
      expect(screen.getAllByRole("switch")).toHaveLength(3);
      await expectNoViolations(full.container, "list with switches");
      await resetScreen();

      const viewOnly = await openScreen({ canManage: false });
      expect(viewOnly.container.querySelectorAll("[data-slot='status-badge']")).toHaveLength(3);
      await expectNoViolations(viewOnly.container, "list without people.manage");
      await resetScreen();

      const readOnly = await openScreen({ billing: "read_only" });
      await screen.findByText("Read-only until billing is settled");
      expect(readOnly.container.querySelectorAll("[data-slot='status-badge']")).toHaveLength(3);
      await expectNoViolations(readOnly.container, "read-only community");
    });

    it("has no axe violations in the Deleted list, the Delete dialog and a refusal in it", async () => {
      const { container } = await openScreen({
        list: (body) =>
          body.status === "deleted"
            ? json(200, { items: [DELETED_D, DELETED_PAST], nextCursor: null })
            : defaultList(body),
        del: () => json(409, { code: "household_has_children" }),
      });
      fireEvent.change(statusSelect(), { target: { value: "deleted" } });
      await screen.findByText("Lowe Family");
      await expectNoViolations(container, "Deleted list");
      fireEvent.change(statusSelect(), { target: { value: "" } });

      const { dialog } = await openDeleteDialog("Clarke Family");
      await expectNoViolations(document.body, "Delete dialog");
      fireEvent.click(confirmButton(dialog));
      await within(dialog).findByText(MSG_CHILD);
      await expectNoViolations(document.body, "refusal in the dialog");
    });
  });
});
