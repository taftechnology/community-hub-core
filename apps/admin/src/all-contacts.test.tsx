import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { router, Shell } from "./shell";

const TOKEN = "test-token-123";
const SLUG = "test-parish";

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

function mockApi(
  access: CapabilitiesInput = {},
  listResult: { items: unknown[]; nextCursor: string | null } | number = {
    items: [],
    nextCursor: null,
  },
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
    const url = String(info);
    const path = url.replace(/^https?:\/\/[^/]+/, "");

    if (path === "/v1/access/capabilities") {
      return mockCapabilitiesResponse(access);
    }

    if (path === "/v1/people/list") {
      if (typeof listResult === "number") {
        return new Response(null, { status: listResult });
      }
      return new Response(JSON.stringify(listResult), {
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
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    return new Response(null, { status: 404 });
  });
}

async function showContacts(): Promise<HTMLElement> {
  await router.navigate("/contacts");
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

describe("Admin Nav Contacts item (Pin 15)", () => {
  it("hides Contacts & Members when people.directory is disabled", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({ directoryEnabled: false, canView: true, canManage: true, canReadMinors: true });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await act(async () => {});
    expect(screen.queryByText("Contacts & Members")).toBeNull();
    expect(screen.queryByRole("link", { name: "All Contacts" })).toBeNull();
  });

  it("hides Contacts & Members when caller lacks people.view even if canManage is true (Deviation 14a)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({ directoryEnabled: true, canView: false, canManage: true, canReadMinors: false });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await act(async () => {});
    expect(screen.queryByText("Contacts & Members")).toBeNull();
    expect(screen.queryByRole("link", { name: "All Contacts" })).toBeNull();
  });

  it("hides Contacts & Members when caller lacks both people.view and people.manage", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({ directoryEnabled: true, canView: false, canManage: false, canReadMinors: false });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await act(async () => {});
    expect(screen.queryByText("Contacts & Members")).toBeNull();
    expect(screen.queryByRole("link", { name: "All Contacts" })).toBeNull();
  });

  it("shows Contacts & Members and All Contacts link when entitled and canView", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({ directoryEnabled: true, canView: true, canManage: false, canReadMinors: false });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Contacts & Members")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Admin" });
    const link = within(nav).getByRole("link", { name: "All Contacts" });
    expect(link.getAttribute("href")).toBe("/contacts");
  });

  it("hides Contacts & Members and Family Records when access route returns 403 or unavailable with granting body (finding 4)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi(403);

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await act(async () => {});
    expect(screen.queryByText("Contacts & Members")).toBeNull();
    expect(screen.queryByRole("link", { name: "All Contacts" })).toBeNull();
    expect(screen.queryByText("Family Records")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();
  });

  it("hides Contacts & Members and Family Records when access route returns 500 with granting body (finding 4)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi(500);

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await act(async () => {});
    expect(screen.queryByText("Contacts & Members")).toBeNull();
    expect(screen.queryByRole("link", { name: "All Contacts" })).toBeNull();
    expect(screen.queryByText("Family Records")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();
  });
});

describe("All Contacts Screen", () => {
  it("asks for sign in when no token is present", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("fetch called");
    });
    await showContacts();
    expect(screen.getByRole("heading", { name: "All Contacts" })).toBeTruthy();
    expect(screen.getByText("Sign in required")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows not allowed when access is forbidden", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({ directoryEnabled: true, canView: false, canManage: false, canReadMinors: false });

    const container = await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Not allowed")).toBeTruthy();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("shows not allowed and makes no list call when caller has canManage but lacks canView (Deviation 14a)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let accessCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        accessCalls++;
        return mockCapabilitiesResponse({ canView: false, canReadMinors: false });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() => expect(accessCalls).toBeGreaterThanOrEqual(1));
    await act(async () => {});

    expect(screen.getByText("Not allowed")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Adults" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();

    const peopleCalls = fetchSpy.mock.calls.filter(
      (call) =>
        String(call[0]).includes("/v1/people/") &&
        !String(call[0]).endsWith("/v1/access/capabilities"),
    );
    expect(peopleCalls).toHaveLength(0);
  });

  it("shows not allowed and makes no list call when directoryEnabled is false (Pin 15)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let accessCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        accessCalls++;
        return mockCapabilitiesResponse({ directoryEnabled: false });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() => expect(accessCalls).toBeGreaterThanOrEqual(1));
    await act(async () => {});

    expect(screen.getByText("Not allowed")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Adults" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();

    const peopleCalls = fetchSpy.mock.calls.filter(
      (call) =>
        String(call[0]).includes("/v1/people/") &&
        !String(call[0]).endsWith("/v1/access/capabilities"),
    );
    expect(peopleCalls).toHaveLength(0);
  });

  it("shows not allowed and makes no list call when access response omits canView or it is non-boolean", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let accessCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        accessCalls++;
        return new Response(
          JSON.stringify({
            permissions: {
              "people.manage": true,
              "people.restricted.read": true,
            },
            entitlements: {
              "people.directory": true,
              "people.households": true,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() => expect(accessCalls).toBeGreaterThanOrEqual(1));
    await act(async () => {});

    expect(screen.getByText("Not allowed")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Adults" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();

    const peopleCalls = fetchSpy.mock.calls.filter(
      (call) =>
        String(call[0]).includes("/v1/people/") &&
        !String(call[0]).endsWith("/v1/access/capabilities"),
    );
    expect(peopleCalls).toHaveLength(0);
  });

  it("shows not allowed and makes no list call when access response omits directoryEnabled or it is non-boolean", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let accessCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        accessCalls++;
        return new Response(
          JSON.stringify({
            permissions: {
              "people.view": true,
              "people.manage": true,
              "people.restricted.read": true,
            },
            entitlements: {
              "people.households": true,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() => expect(accessCalls).toBeGreaterThanOrEqual(1));
    await act(async () => {});

    expect(screen.getByText("Not allowed")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Adults" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();

    const peopleCalls = fetchSpy.mock.calls.filter(
      (call) =>
        String(call[0]).includes("/v1/people/") &&
        !String(call[0]).endsWith("/v1/access/capabilities"),
    );
    expect(peopleCalls).toHaveLength(0);
  });

  it("shows not allowed and makes no list call when access response is not valid JSON", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let accessCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        accessCalls++;
        return new Response("not valid json {", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() => expect(accessCalls).toBeGreaterThanOrEqual(1));
    await act(async () => {});

    expect(screen.getByText("Not allowed")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Adults" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();

    const peopleCalls = fetchSpy.mock.calls.filter(
      (call) =>
        String(call[0]).includes("/v1/people/") &&
        !String(call[0]).endsWith("/v1/access/capabilities"),
    );
    expect(peopleCalls).toHaveLength(0);
  });

  it("treats missing permission fields in access response as not allowed (Pin 15)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const adultPerson = {
      id: "00000000-0000-4000-8000-000000000001",
      personId: "00000000-0000-4000-8000-000000000001",
      isMinor: false,
      givenName: "Grace",
      familyName: "Hopper",
      version: 1,
    };
    const adultDetail = {
      personId: "00000000-0000-4000-8000-000000000001",
      householdId: null,
      isMinor: false,
      ageBasis: "recorded",
      birthdayMd: null,
      givenName: "Grace",
      familyName: "Hopper",
      email: null,
      phone: null,
      dateOfBirth: null,
      version: 1,
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        // canManage and canReadMinors omitted entirely
        return new Response(
          JSON.stringify({
            permissions: {
              "people.view": true,
            },
            entitlements: {
              "people.directory": true,
              "people.households": true,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        return new Response(JSON.stringify(adultDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Grace")).toBeTruthy();
    // Add contact button must NOT appear
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();
    // Minors tab must NOT appear
    expect(screen.queryByRole("button", { name: "Minors" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Minors" })).toBeNull();

    // In detail view, Edit contact button must NOT appear
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));
    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    expect(await screen.findByText("Given name:")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit contact" })).toBeNull();
  });

  it("hides Add and Edit controls when billing status is read_only (Pin 15)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const adultPerson = {
      id: "00000000-0000-4000-8000-000000000001",
      personId: "00000000-0000-4000-8000-000000000001",
      isMinor: false,
      givenName: "Grace",
      familyName: "Hopper",
      version: 1,
    };
    const adultDetail = {
      personId: "00000000-0000-4000-8000-000000000001",
      householdId: null,
      isMinor: false,
      ageBasis: "recorded",
      birthdayMd: null,
      givenName: "Grace",
      familyName: "Hopper",
      email: null,
      phone: null,
      dateOfBirth: null,
      version: 1,
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "read_only",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        return new Response(JSON.stringify(adultDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    const container = await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Grace")).toBeTruthy();
    expect(await screen.findByText(/Read-only until billing is settled/i)).toBeTruthy();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
    // Add button must be hidden when read_only
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();

    // View detail
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));
    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    expect(await screen.findByText("Given name:")).toBeTruthy();
    // Edit button must be hidden when read_only
    expect(screen.queryByRole("button", { name: "Edit contact" })).toBeNull();
  });

  it("renders adult list and passes axe", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const adultPerson = {
      id: "00000000-0000-4000-8000-000000000001",
      personId: "00000000-0000-4000-8000-000000000001",
      isMinor: false,
      givenName: "Grace",
      familyName: "Hopper",
      version: 1,
    };
    mockApi(
      { directoryEnabled: true, canView: true, canManage: false, canReadMinors: false },
      { items: [adultPerson], nextCursor: null },
    );

    const container = await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Grace")).toBeTruthy();
    expect(screen.getByText("Hopper")).toBeTruthy();

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("sends search term only in request body, not in URL or console", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const storageStore = new Map<string, string>();
    const localStorageStub: Storage = {
      getItem: (key: string) => storageStore.get(key) ?? null,
      setItem: (key: string, val: string) => {
        storageStore.set(key, String(val));
      },
      removeItem: (key: string) => {
        storageStore.delete(key);
      },
      clear: () => {
        storageStore.clear();
      },
      key: (index: number) => Array.from(storageStore.keys())[index] ?? null,
      get length() {
        return storageStore.size;
      },
    };
    vi.stubGlobal("localStorage", localStorageStub);

    const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
    const consoleSpies = consoleMethods.map((method) => vi.spyOn(console, method));

    const adultPerson = {
      id: "00000000-0000-4000-8000-000000000001",
      personId: "00000000-0000-4000-8000-000000000001",
      isMinor: false,
      givenName: "Grace",
      familyName: "Hopper",
      version: 1,
    };
    const adultDetail = {
      personId: "00000000-0000-4000-8000-000000000001",
      householdId: null,
      isMinor: false,
      ageBasis: "recorded",
      birthdayMd: null,
      givenName: "Grace",
      familyName: "Hopper",
      email: null,
      phone: null,
      dateOfBirth: null,
      version: 1,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        return new Response(JSON.stringify(adultDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/create") {
        return new Response(JSON.stringify({ personId: "00000000-0000-4000-8000-000000000002" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/update") {
        return new Response(JSON.stringify({ version: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await screen.findByRole("heading", { name: "All Contacts" });
    const searchInput = await screen.findByRole("textbox", { name: "Search contacts" });
    fireEvent.change(searchInput, { target: { value: "SecretSearchTerm" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await act(async () => {});

    const listCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith("/v1/people/list"),
    );
    const listCall = listCalls[listCalls.length - 1];
    expect(listCall).toBeDefined();
    const listInit = listCall?.[1] as RequestInit | undefined;
    const listBody = listInit?.body
      ? (JSON.parse(String(listInit.body)) as {
          search?: string;
          communitySlug?: string;
          kind?: string;
        })
      : undefined;

    expect(listBody?.search).toBe("SecretSearchTerm");
    expect(listBody?.communitySlug).toBe(SLUG);
    expect(listBody?.kind).toBe("adults");

    expect(window.location.href).not.toContain("SecretSearchTerm");
    expect(window.location.search).not.toContain("SecretSearchTerm");

    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain("SecretSearchTerm");
        }
      }
    }

    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)!;
      expect(key).not.toContain("SecretSearchTerm");
      expect(sessionStorage.getItem(key)).not.toContain("SecretSearchTerm");
    }
    const local = window.localStorage;
    for (let i = 0; i < local.length; i++) {
      const key = local.key(i)!;
      expect(key).not.toContain("SecretSearchTerm");
      expect(local.getItem(key)).not.toContain("SecretSearchTerm");
    }

    // Test Add submit path
    const addBtn = await screen.findByRole("button", { name: "Add contact" });
    fireEvent.click(addBtn);
    expect(await screen.findByRole("heading", { name: "Add Contact" })).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Given name" }), {
      target: { value: "SecretAddName" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Family name" }), {
      target: { value: "SecretAddFamily" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "secretadd@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save contact" }));

    await act(async () => {});

    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain("SecretAddName");
          expect(String(arg)).not.toContain("secretadd@example.test");
        }
      }
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)!;
      expect(key).not.toContain("SecretAddName");
      expect(sessionStorage.getItem(key)).not.toContain("SecretAddName");
    }
    for (let i = 0; i < local.length; i++) {
      const key = local.key(i)!;
      expect(key).not.toContain("SecretAddName");
      expect(local.getItem(key)).not.toContain("SecretAddName");
    }

    // Test Edit submit path with personal data
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));
    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    const editBtn = await screen.findByRole("button", { name: "Edit contact" });
    fireEvent.click(editBtn);
    expect(await screen.findByRole("heading", { name: "Edit Contact" })).toBeTruthy();

    const givenNameInput = screen.getByRole("textbox", { name: "Given name" });
    fireEvent.change(givenNameInput, { target: { value: "SecretPersonalName" } });
    const emailInput = screen.getByRole("textbox", { name: "Email" });
    fireEvent.change(emailInput, { target: { value: "secretpersonal@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await act(async () => {});

    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain("SecretPersonalName");
          expect(String(arg)).not.toContain("secretpersonal@example.test");
        }
      }
    }

    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)!;
      expect(key).not.toContain("SecretPersonalName");
      expect(sessionStorage.getItem(key)).not.toContain("SecretPersonalName");
    }
    for (let i = 0; i < local.length; i++) {
      const key = local.key(i)!;
      expect(key).not.toContain("SecretPersonalName");
      expect(local.getItem(key)).not.toContain("SecretPersonalName");
    }
  });

  it("handles keyset pagination when nextCursor is returned", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let requestedCursor: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        requestedCursor = body.cursor;
        if (!body.cursor) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "1",
                  personId: "1",
                  isMinor: false,
                  givenName: "First",
                  familyName: "Page",
                  version: 1,
                },
              ],
              nextCursor: "cursor-page-2",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "2",
                personId: "2",
                isMinor: false,
                givenName: "Second",
                familyName: "Page",
                version: 1,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("First")).toBeTruthy();
    const nextButton = screen.getByRole("button", { name: "Next page" });
    fireEvent.click(nextButton);

    expect(await screen.findByText("Second")).toBeTruthy();
    expect(requestedCursor).toBe("cursor-page-2");
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("Minors tab appears only with people.restricted.read (Pin 15)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi(
      { directoryEnabled: true, canView: true, canManage: true, canReadMinors: false },
      { items: [], nextCursor: null },
    );

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await screen.findByText("No contacts yet");
    expect(screen.queryByRole("button", { name: "Minors" })).toBeNull();
    expect(screen.queryByText("Minors")).toBeNull();
  });

  it("renders Minors switch and fetches minors when canReadMinors is true", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let capturedKind: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        capturedKind = body.kind;
        if (body.kind === "minors") {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "minor-1",
                  personId: "minor-1",
                  isMinor: true,
                  givenName: "Child",
                  familyName: "Person",
                  version: 1,
                },
              ],
              nextCursor: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    const container = await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const group = await screen.findByRole("group", { name: "Contact types" });
    const adultsBtn = within(group).getByRole("button", { name: "Adults" });
    const minorsBtn = within(group).getByRole("button", { name: "Minors" });
    expect(adultsBtn.getAttribute("aria-pressed")).toBe("true");
    expect(minorsBtn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(minorsBtn);

    expect(await screen.findByText("Child")).toBeTruthy();
    expect(capturedKind).toBe("minors");
    expect(adultsBtn.getAttribute("aria-pressed")).toBe("false");
    expect(minorsBtn.getAttribute("aria-pressed")).toBe("true");

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("clicking the active tab keeps the list without reloading or making requests", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let listCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        listCallCount++;
        if (body.kind === "minors") {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "minor-1",
                  personId: "minor-1",
                  isMinor: true,
                  givenName: "Child",
                  familyName: "Person",
                  version: 1,
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
                id: "adult-1",
                personId: "adult-1",
                isMinor: false,
                givenName: "Adult",
                familyName: "Contact",
                version: 1,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const group = await screen.findByRole("group", { name: "Contact types" });
    const adultsBtn = within(group).getByRole("button", { name: "Adults" });
    const minorsBtn = within(group).getByRole("button", { name: "Minors" });

    expect(await screen.findByText("Adult")).toBeTruthy();
    const callsAfterAdultsLoad = listCallCount;
    expect(callsAfterAdultsLoad).toBeGreaterThanOrEqual(1);

    // Clicking already-active Adults tab must keep list and not make requests
    fireEvent.click(adultsBtn);
    expect(screen.queryByText("Adult")).toBeTruthy();
    expect(listCallCount).toBe(callsAfterAdultsLoad);

    // Switch to Minors
    fireEvent.click(minorsBtn);
    expect(await screen.findByText("Child")).toBeTruthy();
    const callsAfterMinorsLoad = listCallCount;

    // Clicking already-active Minors tab must keep list and not make requests
    fireEvent.click(minorsBtn);
    expect(screen.queryByText("Child")).toBeTruthy();
    expect(listCallCount).toBe(callsAfterMinorsLoad);
  });

  it("empty state shows 'No contacts yet' and Add button only with people.manage (Pin 15)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi(
      { directoryEnabled: true, canView: true, canManage: false, canReadMinors: false },
      { items: [], nextCursor: null },
    );

    const container = await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("No contacts yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("empty state shows Add button when canManage is true", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi(
      { directoryEnabled: true, canView: true, canManage: true, canReadMinors: false },
      { items: [], nextCursor: null },
    );

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("No contacts yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add contact" })).toBeTruthy();
  });

  it("no match state shows 'No contacts match'", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi(
      { directoryEnabled: true, canView: true, canManage: true, canReadMinors: false },
      { items: [], nextCursor: null },
    );

    const container = await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await screen.findByRole("heading", { name: "All Contacts" });
    const searchInput = await screen.findByRole("textbox", { name: "Search contacts" });
    fireEvent.change(searchInput, { target: { value: "NonExistent" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("No contacts match")).toBeTruthy();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("error state shows error alert with Retry button and no raw error text", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        attempts++;
        if (attempts === 1) {
          return new Response(
            JSON.stringify({ secret_db_error: "connection failure 0xDEADBEEF" }),
            {
              status: 500,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "1",
                personId: "1",
                isMinor: false,
                givenName: "Recovered",
                familyName: "Contact",
                version: 1,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    const container = await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const errorAlert = await screen.findByRole("alert");
    expect(within(errorAlert).getByText("Failed to load contacts")).toBeTruthy();
    expect(document.body.textContent).not.toContain("0xDEADBEEF");
    expect(document.body.textContent).not.toContain("connection failure");

    const retryButton = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);

    expect(await screen.findByText("Recovered")).toBeTruthy();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("shows read-only banner or message when list returns 402", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({ directoryEnabled: true, canView: true, canManage: true, canReadMinors: false }, 402);

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(
      await screen.findByText(/Read-only until billing is settled|Payment required/i),
    ).toBeTruthy();
  });

  it("populated list shows Add button only with people.manage (Pin 15)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const samplePerson = {
      id: "00000000-0000-4000-8000-000000000001",
      personId: "00000000-0000-4000-8000-000000000001",
      isMinor: false,
      givenName: "Grace",
      familyName: "Hopper",
      version: 1,
    };

    // First: canManage: false -> Add contact button is hidden
    mockApi(
      { directoryEnabled: true, canView: true, canManage: false, canReadMinors: false },
      { items: [samplePerson], nextCursor: null },
    );
    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Grace")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();
  });

  it("Minors tab has no search box and never sends includeRestricted, isMinor, orgId, communityId in request bodies (Deviation 14c)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const recordedBodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      recordedBodies.push(body);

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const searchInput = await screen.findByRole("textbox", { name: "Search contacts" });
    fireEvent.change(searchInput, { target: { value: "some-search" } });
    fireEvent.submit(searchInput.closest("form")!);

    const minorsTab = screen.getByRole("button", { name: "Minors" });
    fireEvent.click(minorsTab);

    // Minors tab must NOT render the search box
    expect(screen.queryByRole("textbox", { name: "Search contacts" })).toBeNull();

    await waitFor(() => expect(recordedBodies.some((b) => b.kind === "minors")).toBe(true));
    const minorsCalls = recordedBodies.filter((b) => b.kind === "minors");
    expect(minorsCalls.length).toBeGreaterThanOrEqual(1);
    for (const body of minorsCalls) {
      expect(body.search).toBeUndefined();
      expect(Object.keys(body).sort()).toEqual(["communitySlug", "kind"].sort());
    }

    // Verify all request bodies never contain forbidden fields
    for (const body of recordedBodies) {
      expect(body.includeRestricted).toBeUndefined();
      expect(body.isMinor).toBeUndefined();
      expect(body.orgId).toBeUndefined();
      expect(body.communityId).toBeUndefined();
    }
  });

  it("resets list state, cursor, search, forms, and selected person when community slug changes", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const personA = {
      id: "00000000-0000-4000-8000-000000000001",
      personId: "00000000-0000-4000-8000-000000000001",
      isMinor: false,
      givenName: "AliceFromA",
      familyName: "Smith",
      version: 1,
    };
    const personB = {
      id: "00000000-0000-4000-8000-000000000002",
      personId: "00000000-0000-4000-8000-000000000002",
      isMinor: false,
      givenName: "BobFromB",
      familyName: "Jones",
      version: 1,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        if (body.communitySlug === "community-a") {
          return new Response(JSON.stringify({ items: [personA], nextCursor: "cursor-a" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (body.communitySlug === "community-b") {
          return new Response(JSON.stringify({ items: [personB], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });

    // Set community A
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    expect(await screen.findByText("AliceFromA")).toBeTruthy();

    // Switch to Minors tab
    const minorsTab = screen.getByRole("button", { name: "Minors" });
    fireEvent.click(minorsTab);

    // Switch community to B
    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    expect(await screen.findByText("BobFromB")).toBeTruthy();
    expect(screen.queryByText("AliceFromA")).toBeNull();

    // Verify request for community-b did not send community-a's cursor or search
    const callsB = fetchSpy.mock.calls.filter((call) => {
      if (!String(call[0]).endsWith("/v1/people/list")) {
        return false;
      }
      const init = call[1] as RequestInit | undefined;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      return body.communitySlug === "community-b";
    });
    expect(callsB.length).toBeGreaterThan(0);
    for (const call of callsB) {
      const init = call[1] as RequestInit | undefined;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      expect(body.cursor).toBeUndefined();
      expect(body.search).toBeUndefined();
      expect(body.kind).toBe("adults");
    }
  });

  it("clears displayed items when list call answers 402 (SW11 402 branch)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const personA = {
      id: "00000000-0000-4000-8000-000000000001",
      personId: "00000000-0000-4000-8000-000000000001",
      isMinor: false,
      givenName: "AliceFromA",
      familyName: "Smith",
      version: 1,
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        if (body.search === "trigger402") {
          return new Response(null, { status: 402 });
        }
        return new Response(JSON.stringify({ items: [personA], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "read_only",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    expect(await screen.findByText("AliceFromA")).toBeTruthy();

    const searchInput = screen.getByRole("textbox", { name: "Search contacts" });
    fireEvent.change(searchInput, { target: { value: "trigger402" } });
    fireEvent.submit(searchInput.closest("form")!);

    expect(
      await screen.findByText(/Read-only until billing is settled|Payment required/i),
    ).toBeTruthy();
    expect(screen.queryByText("AliceFromA")).toBeNull();
  });

  it("switches to a community whose list answers 402 and asserts previous names are gone", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const personA = {
      id: "00000000-0000-4000-8000-000000000001",
      personId: "00000000-0000-4000-8000-000000000001",
      isMinor: false,
      givenName: "AliceFromA",
      familyName: "Smith",
      version: 1,
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        if (body.communitySlug === "community-b") {
          return new Response(null, { status: 402 });
        }
        return new Response(JSON.stringify({ items: [personA], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "read_only",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    expect(await screen.findByText("AliceFromA")).toBeTruthy();

    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    expect(
      await screen.findByText(/Read-only until billing is settled|Payment required/i),
    ).toBeTruthy();
    expect(screen.queryByText("AliceFromA")).toBeNull();
  });

  it("immediately clears items on community switch while new community list is loading (SW1)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const personA = {
      id: "00000000-0000-4000-8000-000000000001",
      personId: "00000000-0000-4000-8000-000000000001",
      isMinor: false,
      givenName: "AliceFromA",
      familyName: "Smith",
      version: 1,
    };
    let resolveBList: ((value: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        if (body.communitySlug === "community-b") {
          return new Promise<Response>((resolve) => {
            resolveBList = resolve;
          });
        }
        return new Response(JSON.stringify({ items: [personA], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    expect(await screen.findByText("AliceFromA")).toBeTruthy();

    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    // Items from community-a must immediately be cleared while community-b's list is loading
    expect(screen.queryByText("AliceFromA")).toBeNull();

    if (resolveBList) {
      resolveBList(
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
  });

  it("resets active tab to adults on community switch (SW2)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const recordedKinds: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        if (body.communitySlug === "community-b") {
          recordedKinds.push(String(body.kind));
        }
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    const group = await screen.findByRole("group", { name: "Contact types" });
    const adultsBtn = within(group).getByRole("button", { name: "Adults" });
    const minorsBtn = within(group).getByRole("button", { name: "Minors" });

    fireEvent.click(minorsBtn);
    expect(minorsBtn.getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    await waitFor(() => expect(recordedKinds.length).toBeGreaterThanOrEqual(1));
    expect(adultsBtn.getAttribute("aria-pressed")).toBe("true");
    expect(minorsBtn.getAttribute("aria-pressed")).toBe("false");
    expect(recordedKinds[0]).toBe("adults");
  });

  it("resets search draft input on community switch (SW3)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({ directoryEnabled: true, canView: true, canManage: true, canReadMinors: true });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    const searchInput = (await screen.findByRole("textbox", {
      name: "Search contacts",
    })) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "draft-search-text" } });
    expect(searchInput.value).toBe("draft-search-text");

    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    const newSearchInput = (await screen.findByRole("textbox", {
      name: "Search contacts",
    })) as HTMLInputElement;
    expect(newSearchInput.value).toBe("");
  });

  it("resets submitted search on community switch so new community does not send search parameter (SW4)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const callsB: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        if (body.communitySlug === "community-b") {
          callsB.push(body);
          return new Response(JSON.stringify({ items: [], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    const searchInput = await screen.findByRole("textbox", { name: "Search contacts" });
    fireEvent.change(searchInput, { target: { value: "active-search" } });
    fireEvent.submit(searchInput.closest("form")!);

    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    expect(await screen.findByText("No contacts yet")).toBeTruthy();
    expect(screen.queryByText("No contacts match")).toBeNull();
    await waitFor(() => expect(callsB.length).toBeGreaterThanOrEqual(1));
    for (const body of callsB) {
      expect(body.search).toBeUndefined();
    }
  });

  it("resets pagination cursor on community switch so new community fetches first page (SW5)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const callsB: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        if (body.communitySlug === "community-b") {
          callsB.push(body);
          return new Response(JSON.stringify({ items: [], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "person-1",
                personId: "person-1",
                isMinor: false,
                givenName: "Person1",
                familyName: "Family1",
                version: 1,
              },
            ],
            nextCursor: "cursor-page-2",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    const nextBtn = await screen.findByRole("button", { name: "Next page" });
    fireEvent.click(nextBtn);

    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    await waitFor(() => expect(callsB.length).toBeGreaterThanOrEqual(2));
    for (const call of callsB) {
      expect(call.cursor).toBeUndefined();
    }
  });

  it("resets view to list on community switch away from Add form (SW6)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({ directoryEnabled: true, canView: true, canManage: true, canReadMinors: true });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    const addBtn = await screen.findByRole("button", { name: "Add contact" });
    fireEvent.click(addBtn);

    expect(screen.getByRole("heading", { name: "Add Contact" })).toBeTruthy();

    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Add Contact" })).toBeNull());
    expect(screen.getByRole("heading", { name: "All Contacts" })).toBeTruthy();
  });

  it("resets add form data on community switch (SW7)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi({ directoryEnabled: true, canView: true, canManage: true, canReadMinors: true });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    const addBtn = await screen.findByRole("button", { name: "Add contact" });
    fireEvent.click(addBtn);

    const givenNameInput = screen.getByRole("textbox", { name: "Given name" }) as HTMLInputElement;
    fireEvent.change(givenNameInput, { target: { value: "DraftNewPerson" } });
    expect(givenNameInput.value).toBe("DraftNewPerson");

    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    const addBtnB = await screen.findByRole("button", { name: "Add contact" });
    fireEvent.click(addBtnB);

    const givenNameInputB = screen.getByRole("textbox", { name: "Given name" }) as HTMLInputElement;
    expect(givenNameInputB.value).toBe("");
  });

  it("resets edit form data on community switch (SW8)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const personA = {
      id: "00000000-0000-4000-8000-000000000001",
      personId: "00000000-0000-4000-8000-000000000001",
      isMinor: false,
      givenName: "AliceFromA",
      familyName: "Smith",
      version: 1,
    };
    const personB = {
      id: "00000000-0000-4000-8000-000000000002",
      personId: "00000000-0000-4000-8000-000000000002",
      isMinor: false,
      givenName: "BobFromB",
      familyName: "Jones",
      version: 1,
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        if (body.communitySlug === "community-b") {
          return new Response(JSON.stringify({ items: [personB], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ items: [personA], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        if (body.personId === personB.personId) {
          return new Response(JSON.stringify({ ...personB, ageBasis: "recorded" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ...personA, ageBasis: "recorded" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    const viewAlice = await screen.findByRole("button", { name: "View AliceFromA Smith" });
    fireEvent.click(viewAlice);

    const editAlice = await screen.findByRole("button", { name: "Edit contact" });
    fireEvent.click(editAlice);

    const givenNameInput = screen.getByRole("textbox", { name: "Given name" }) as HTMLInputElement;
    fireEvent.change(givenNameInput, { target: { value: "ModifiedAliceDraft" } });
    expect(givenNameInput.value).toBe("ModifiedAliceDraft");

    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    const viewBob = await screen.findByRole("button", { name: "View BobFromB Jones" });
    fireEvent.click(viewBob);

    const editBob = await screen.findByRole("button", { name: "Edit contact" });
    fireEvent.click(editBob);

    const givenNameInputB = screen.getByRole("textbox", { name: "Given name" }) as HTMLInputElement;
    expect(givenNameInputB.value).toBe("BobFromB");
  });

  it("discards an in-flight person read after community switch so prior values never appear", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const personA = {
      id: "00000000-0000-4000-8000-000000000031",
      personId: "00000000-0000-4000-8000-000000000031",
      isMinor: false,
      givenName: "StaleGiven",
      familyName: "StaleFamily",
      version: 1,
    };
    const personB = {
      id: "00000000-0000-4000-8000-000000000032",
      personId: "00000000-0000-4000-8000-000000000032",
      isMinor: false,
      givenName: "FreshGiven",
      familyName: "FreshFamily",
      version: 1,
    };
    let resolveStaleRead: ((value: Response) => void) | undefined;
    let personAReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        if (body.communitySlug === "community-b") {
          return new Response(JSON.stringify({ items: [personB], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ items: [personA], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        if (body.personId === personA.personId) {
          personAReads += 1;
          if (personAReads === 1) {
            return new Response(
              JSON.stringify({
                ...personA,
                email: null,
                phone: null,
                dateOfBirth: null,
                ageBasis: "recorded",
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          }
          return new Promise<Response>((resolve) => {
            resolveStaleRead = resolve;
          });
        }
        return new Response(
          JSON.stringify({
            ...personB,
            email: null,
            phone: null,
            dateOfBirth: null,
            ageBasis: "recorded",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (path === "/v1/people/update") {
        return new Response(JSON.stringify({ field: "version_conflict" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    fireEvent.click(await screen.findByRole("button", { name: "View StaleGiven StaleFamily" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit contact" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Family name" }), {
      target: { value: "DraftFamily" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("button", { name: "Reload" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    expect(await screen.findByRole("button", { name: "View FreshGiven FreshFamily" })).toBeTruthy();

    resolveStaleRead?.(
      new Response(
        JSON.stringify({
          ...personA,
          email: "stale@example.test",
          phone: null,
          dateOfBirth: null,
          ageBasis: "recorded",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    await act(async () => {});

    expect(screen.queryByText("StaleGiven")).toBeNull();
    expect(screen.queryByText("StaleFamily")).toBeNull();
    expect(screen.queryByText("stale@example.test")).toBeNull();
    expect(screen.queryByDisplayValue("StaleGiven")).toBeNull();
    expect(screen.queryByDisplayValue("DraftFamily")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View FreshGiven FreshFamily" }));
    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    expect(screen.queryByText("StaleGiven")).toBeNull();
    expect(await screen.findByText("FreshGiven")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit contact" }));
    expect(await screen.findByRole("heading", { name: "Edit Contact" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Given name" }) as HTMLInputElement).value).toBe(
      "FreshGiven",
    );
    expect((screen.getByRole("textbox", { name: "Family name" }) as HTMLInputElement).value).toBe(
      "FreshFamily",
    );
    expect((screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement).value).toBe("");
    expect(screen.queryByDisplayValue("StaleGiven")).toBeNull();
    expect(screen.queryByDisplayValue("stale@example.test")).toBeNull();
  });

  it("clears payment required banner on community switch to healthy community (SW9)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        if (body.communitySlug === "community-a") {
          return new Response(null, { status: 402 });
        }
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/billing/status") {
        return new Response(
          JSON.stringify({
            state: "read_only",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    expect(
      await screen.findByText(/Read-only until billing is settled|Payment required/i),
    ).toBeTruthy();

    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    await waitFor(() =>
      expect(screen.queryByText(/Read-only until billing is settled|Payment required/i)).toBeNull(),
    );
  });

  it("clears error alert on community switch to healthy community (SW10)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        if (body.communitySlug === "community-a") {
          return new Response(null, { status: 500 });
        }
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Failed to load contacts")).toBeTruthy();

    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByText("Failed to load contacts")).toBeNull();
  });

  it("resets submitting state on community switch so submit button in new community is enabled", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let createResolve: ((value: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");

      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/create") {
        return new Promise<Response>((resolve) => {
          createResolve = resolve;
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    const communityInput = screen.getByRole("textbox", { name: "Community" });
    const setButton = screen.getByRole("button", { name: "Set" });
    fireEvent.change(communityInput, { target: { value: "community-a" } });
    fireEvent.click(setButton);

    const addBtn = await screen.findByRole("button", { name: "Add contact" });
    fireEvent.click(addBtn);

    const givenNameInput = screen.getByRole("textbox", { name: "Given name" });
    fireEvent.change(givenNameInput, { target: { value: "PendingSubmit" } });

    // Submit form (which stays in flight)
    fireEvent.submit(givenNameInput.closest("form")!);

    // While submit is in flight in community-a, switch to community-b
    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    const addBtnB = await screen.findByRole("button", { name: "Add contact" });
    fireEvent.click(addBtnB);

    // Submit button in community-b must NOT remain disabled
    const submitBtnB = screen.getByRole("button", { name: "Save contact" }) as HTMLButtonElement;
    expect(submitBtnB.disabled).toBe(false);

    if (createResolve) {
      createResolve(new Response(JSON.stringify({ personId: "created-id" }), { status: 201 }));
    }
  });
});

describe("Detail, Add, and Edit Contact (Task 10)", () => {
  const adultPerson = {
    id: "00000000-0000-4000-8000-000000000010",
    personId: "00000000-0000-4000-8000-000000000010",
    isMinor: false,
    givenName: "Ada",
    familyName: "Lovelace",
    version: 3,
  };

  const adultDetail = {
    personId: "00000000-0000-4000-8000-000000000010",
    householdId: null,
    isMinor: false,
    ageBasis: "recorded",
    birthdayMd: 512,
    givenName: "Ada",
    familyName: "Lovelace",
    email: "ada@example.test",
    phone: "+61400000001",
    dateOfBirth: "1980-05-12",
    version: 3,
  };

  it("shows contact details from /v1/people/read without a Version line and passes axe", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        expect(body.communitySlug).toBe(SLUG);
        expect(body.personId).toBe(adultPerson.id);
        return new Response(JSON.stringify(adultDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    const container = await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Ada")).toBeTruthy();
    const viewButton = screen.getByRole("button", { name: /^View/ });
    fireEvent.click(viewButton);

    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    expect(await screen.findByText("ada@example.test")).toBeTruthy();
    expect(screen.getByText("+61400000001")).toBeTruthy();
    expect(screen.getByText("1980-05-12")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bVersion\b/);

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("hides Edit button in detail view when caller lacks people.manage (Pin 15)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canManage: false, canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        return new Response(JSON.stringify(adultDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));

    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    expect(await screen.findByText("Given name:")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit contact" })).toBeNull();
  });

  it("creates an adult contact via POST /v1/people/create and passes axe", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const createdId = "00000000-0000-4000-8000-000000000099";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/create") {
        return new Response(JSON.stringify({ personId: createdId }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    const container = await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const addButton = await screen.findByRole("button", { name: "Add contact" });
    fireEvent.click(addButton);

    expect(await screen.findByRole("heading", { name: "Add Contact" })).toBeTruthy();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);

    fireEvent.change(screen.getByRole("textbox", { name: "Given name" }), {
      target: { value: "Charles" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Family name" }), {
      target: { value: "Babbage" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "charles@example.test" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save contact" }));

    await act(async () => {});

    const createCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).endsWith("/v1/people/create"),
    );
    expect(createCall).toBeDefined();
    const createInit = createCall?.[1] as RequestInit | undefined;
    const createBody = createInit?.body ? JSON.parse(String(createInit.body)) : {};
    expect(createBody.communitySlug).toBe(SLUG);
    expect(createBody.givenName).toBe("Charles");
    expect(createBody.familyName).toBe("Babbage");
    expect(createBody.email).toBe("charles@example.test");
  });

  it("edits an adult contact, sends current version to POST /v1/people/update, and passes axe", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        return new Response(JSON.stringify(adultDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/update") {
        return new Response(JSON.stringify({ version: 4 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    const container = await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));

    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    const editButton = await screen.findByRole("button", { name: "Edit contact" });
    fireEvent.click(editButton);

    expect(await screen.findByRole("heading", { name: "Edit Contact" })).toBeTruthy();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);

    const givenNameInput = screen.getByRole("textbox", { name: "Given name" });
    expect((givenNameInput as HTMLInputElement).value).toBe("Ada");
    fireEvent.change(givenNameInput, { target: { value: "Augusta" } });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await act(async () => {});

    const updateCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).endsWith("/v1/people/update"),
    );
    expect(updateCall).toBeDefined();
    const updateInit = updateCall?.[1] as RequestInit | undefined;
    const updateBody = updateInit?.body ? JSON.parse(String(updateInit.body)) : {};
    expect(updateBody.communitySlug).toBe(SLUG);
    expect(updateBody.personId).toBe(adultPerson.id);
    expect(updateBody.version).toBe(3);
    expect(updateBody.givenName).toBe("Augusta");
  });

  it("shows plain conflict message that does not name clashing field and offers reload on 409", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        return new Response(JSON.stringify(adultDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/update") {
        return new Response(JSON.stringify({ field: "email_bidx_conflict" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    const container = await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));

    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Edit contact" }));

    expect(await screen.findByRole("heading", { name: "Edit Contact" })).toBeTruthy();
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    saveButton.focus();
    expect(document.activeElement).toBe(saveButton);
    fireEvent.click(saveButton);

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(
      within(alert).getByText(
        /This contact was changed by someone else, or that email or phone is already in use\. Reload to see the latest details; your unsaved changes will be discarded\./,
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(alert);
    });
    expect(document.body.textContent).not.toContain("email_bidx_conflict");

    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("discards the edit draft when Reload after a 409 returns the server person", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let readCount = 0;
    let updateCount = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        readCount += 1;
        if (readCount === 1) {
          return new Response(JSON.stringify(adultDetail), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            ...adultDetail,
            familyName: "ServerFamily",
            version: 2,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (path === "/v1/people/update") {
        updateCount += 1;
        if (updateCount === 1) {
          return new Response(JSON.stringify({ field: "version_conflict" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ version: 3 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit contact" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Family name" }), {
      target: { value: "DraftFamily" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("button", { name: "Reload" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "Family name" }) as HTMLInputElement).value).toBe(
        "ServerFamily",
      );
    });
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await act(async () => {});

    const updateCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith("/v1/people/update"),
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
    const secondBody = JSON.parse(String((updateCalls[1]?.[1] as RequestInit | undefined)?.body));
    expect(secondBody.familyName).toBe("ServerFamily");
    expect(secondBody.version).toBe(2);
  });

  it("keeps the conflict and old version when Reload after a 409 fails to read", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let readCount = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        readCount += 1;
        if (readCount === 1) {
          return new Response(JSON.stringify(adultDetail), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(null, { status: 503 });
      }
      if (path === "/v1/people/update") {
        return new Response(JSON.stringify({ field: "version_conflict" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit contact" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Family name" }), {
      target: { value: "DraftFamily" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const conflictAlert = await screen.findByRole("alert");
    await waitFor(() => {
      expect(document.activeElement).toBe(conflictAlert);
    });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    await act(async () => {});

    const alertAfterReload = await screen.findByRole("alert");
    expect(alertAfterReload).toBeTruthy();
    await waitFor(() => {
      expect(
        document.activeElement === alertAfterReload ||
          alertAfterReload.contains(document.activeElement),
      ).toBe(true);
    });
    expect((screen.getByRole("textbox", { name: "Family name" }) as HTMLInputElement).value).toBe(
      "DraftFamily",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await act(async () => {});

    const updateCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith("/v1/people/update"),
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
    const secondBody = JSON.parse(String((updateCalls[1]?.[1] as RequestInit | undefined)?.body));
    expect(secondBody.version).toBe(3);
    expect(secondBody.familyName).toBe("DraftFamily");
  });

  it("fills the edit form from the person when reopening after Cancel", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        return new Response(JSON.stringify(adultDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit contact" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Given name" }), {
      target: { value: "LocalDraft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Edit contact" }));

    expect(await screen.findByRole("heading", { name: "Edit Contact" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Given name" }) as HTMLInputElement).value).toBe(
      "Ada",
    );
  });

  it("shows plain not-found on 404 in detail view", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 404 });
    });

    const container = await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));

    expect(await screen.findByText("Contact not found")).toBeTruthy();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("never provides create or edit control for a minor", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const minorPerson = {
      id: "minor-1",
      personId: "minor-1",
      isMinor: true,
      givenName: "Child",
      familyName: "Person",
      version: 1,
    };
    const minorDetail = {
      personId: "minor-1",
      householdId: "hh-1",
      isMinor: true,
      ageBasis: "recorded",
      birthdayMd: null,
      givenName: "Child",
      familyName: "Person",
      email: null,
      phone: null,
      dateOfBirth: null,
      version: 1,
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [minorPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        return new Response(JSON.stringify(minorDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const minorsTab = await screen.findByRole("button", { name: "Minors" });
    fireEvent.click(minorsTab);

    expect(await screen.findByText("Child")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^View/ }));

    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    expect(await screen.findByText("Given name:")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit contact" })).toBeNull();
  });

  it("guards Add form against double-submission while in flight", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let createResolve: ((val: Response) => void) | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/create") {
        return new Promise<Response>((resolve) => {
          createResolve = resolve;
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const addButton = await screen.findByRole("button", { name: "Add contact" });
    fireEvent.click(addButton);

    fireEvent.change(screen.getByRole("textbox", { name: "Given name" }), {
      target: { value: "Double" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Family name" }), {
      target: { value: "Click" },
    });

    const saveButton = screen.getByRole("button", { name: "Save contact" });
    // Double click rapidly
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    const createCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith("/v1/people/create"),
    );
    expect(createCalls).toHaveLength(1);

    // Resolve the in-flight request
    createResolve?.(
      new Response(JSON.stringify({ personId: "created-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    await act(async () => {});
  });

  it("guards Edit form against double-submission while in flight", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let updateResolve: ((val: Response) => void) | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        return new Response(JSON.stringify(adultDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/update") {
        return new Promise<Response>((resolve) => {
          updateResolve = resolve;
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));

    const editButton = await screen.findByRole("button", { name: "Edit contact" });
    fireEvent.click(editButton);

    const saveButton = screen.getByRole("button", { name: "Save changes" });
    // Double click rapidly
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    const updateCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith("/v1/people/update"),
    );
    expect(updateCalls).toHaveLength(1);

    updateResolve?.(
      new Response(JSON.stringify({ version: 4 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await act(async () => {});
  });

  it("gives every row action an accessible name including the contact's name", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi(
      { directoryEnabled: true, canView: true, canManage: true, canReadMinors: false },
      { items: [adultPerson], nextCursor: null },
    );

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Ada")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View Ada Lovelace" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();
  });

  it("gives the table an accessible name", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    mockApi(
      { directoryEnabled: true, canView: true, canManage: true, canReadMinors: false },
      { items: [adultPerson], nextCursor: null },
    );

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByRole("table", { name: "Contacts" })).toBeTruthy();
  });

  it("moves focus to the heading after successful Add save", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/create") {
        return new Response(JSON.stringify({ personId: "created-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const addButton = await screen.findByRole("button", { name: "Add contact" });
    fireEvent.click(addButton);

    fireEvent.change(screen.getByRole("textbox", { name: "Given name" }), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Family name" }), {
      target: { value: "Lovelace" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save contact" }));

    await act(async () => {});

    const heading = await screen.findByRole("heading", { name: "All Contacts", level: 1 });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
  });

  it("moves focus to the heading after successful Edit save", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        return new Response(JSON.stringify(adultDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/update") {
        return new Response(JSON.stringify({ version: 4 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));

    const editButton = await screen.findByRole("button", { name: "Edit contact" });
    fireEvent.click(editButton);

    const givenNameInput = screen.getByRole("textbox", { name: "Given name" });
    fireEvent.change(givenNameInput, { target: { value: "Augusta" } });

    const saveButton = screen.getByRole("button", { name: "Save changes" });
    saveButton.focus();
    expect(document.activeElement).toBe(saveButton);
    fireEvent.click(saveButton);

    await act(async () => {});

    const heading = await screen.findByRole("heading", { name: "Contact Details", level: 2 });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
  });

  it("moves focus to the alert on save error", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/create") {
        return new Response(null, { status: 500 });
      }
      return new Response(null, { status: 404 });
    });

    const container = await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const addButton = await screen.findByRole("button", { name: "Add contact" });
    fireEvent.click(addButton);

    fireEvent.change(screen.getByRole("textbox", { name: "Given name" }), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Family name" }), {
      target: { value: "Lovelace" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save contact" }));

    const alert = await screen.findByRole("alert");
    await waitFor(() => {
      expect(document.activeElement).toBe(alert);
    });

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("moves focus to the Add heading on opening Add view", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const addButton = await screen.findByRole("button", { name: "Add contact" });
    addButton.focus();
    expect(document.activeElement).toBe(addButton);
    fireEvent.click(addButton);

    const addHeading = await screen.findByRole("heading", { name: "Add Contact", level: 2 });
    await waitFor(() => {
      expect(document.activeElement).toBe(addHeading);
    });
  });

  it("moves focus to the Detail heading on opening Detail view", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        return new Response(JSON.stringify(adultDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Ada")).toBeTruthy();
    const viewButton = screen.getByRole("button", { name: /^View/ });
    viewButton.focus();
    expect(document.activeElement).toBe(viewButton);
    fireEvent.click(viewButton);

    const detailHeading = await screen.findByRole("heading", { name: "Contact Details", level: 2 });
    await waitFor(() => {
      expect(document.activeElement).toBe(detailHeading);
    });
  });

  it("moves focus to the Edit heading on opening Edit view", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        return new Response(JSON.stringify(adultDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));

    const editButton = await screen.findByRole("button", { name: "Edit contact" });
    editButton.focus();
    expect(document.activeElement).toBe(editButton);
    fireEvent.click(editButton);

    const editHeading = await screen.findByRole("heading", { name: "Edit Contact", level: 2 });
    await waitFor(() => {
      expect(document.activeElement).toBe(editHeading);
    });
  });

  it("moves focus to the alert and asserts role alert on failed Edit save (500)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({ canReadMinors: false });
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/read") {
        return new Response(JSON.stringify(adultDetail), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/people/update") {
        return new Response(null, { status: 500 });
      }
      return new Response(null, { status: 404 });
    });

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^View/ }));

    const editButton = await screen.findByRole("button", { name: "Edit contact" });
    fireEvent.click(editButton);

    const saveButton = await screen.findByRole("button", { name: "Save changes" });
    saveButton.focus();
    expect(document.activeElement).toBe(saveButton);
    fireEvent.click(saveButton);

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(within(alert).getByText("Unable to save changes")).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(alert);
    });
  });

  describe("Task 5 All Contacts list restyle", () => {
    it("hides Add contact when search returns no items, and shows Add contact when search returns items (Pin 24)", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      const adultPerson = {
        id: "adult-1",
        personId: "adult-1",
        isMinor: false,
        givenName: "Mira",
        familyName: "Tolland",
        version: 1,
      };
      vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({ canManage: true, canReadMinors: false });
        }
        if (path === "/v1/people/list") {
          if (body.search === "Tolland") {
            return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (body.search === "Nobody") {
            return new Response(JSON.stringify({ items: [], nextCursor: null }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(null, { status: 404 });
      });

      await showContacts();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("Mira")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Add contact" })).toBeTruthy();

      const searchInput = screen.getByRole("textbox", { name: "Search contacts" });
      fireEvent.change(searchInput, { target: { value: "Nobody" } });
      fireEvent.click(screen.getByRole("button", { name: "Search" }));

      expect(await screen.findByText("No contacts match")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();

      // Control: search that returns items shows Add contact
      fireEvent.change(searchInput, { target: { value: "Tolland" } });
      fireEvent.click(screen.getByRole("button", { name: "Search" }));

      expect(await screen.findByText("Mira")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Add contact" })).toBeTruthy();
    });

    it("renders Avatar on adults list and no Avatar on minors list (Pin 25)", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      const adultPerson1 = {
        id: "adult-1",
        personId: "adult-1",
        isMinor: false,
        givenName: "Mira",
        familyName: "Tolland",
        version: 1,
      };
      const adultPerson2 = {
        id: "adult-2",
        personId: "adult-2",
        isMinor: false,
        givenName: "Owen",
        familyName: "Barrah",
        version: 1,
      };
      const minorPerson1 = {
        id: "minor-1",
        personId: "minor-1",
        isMinor: true,
        givenName: "Pip",
        familyName: "Tolland",
        version: 1,
      };

      vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({ canReadMinors: true });
        }
        if (path === "/v1/people/list") {
          if (body.kind === "minors") {
            return new Response(JSON.stringify({ items: [minorPerson1], nextCursor: null }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({ items: [adultPerson1, adultPerson2], nextCursor: null }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(null, { status: 404 });
      });

      await showContacts();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("Mira")).toBeTruthy();
      expect(screen.getByText("Owen")).toBeTruthy();

      // Control: Adults list shows one [data-slot="avatar"] per row, each with aria-hidden="true"
      const adultAvatars = document.querySelectorAll('[data-slot="avatar"]');
      expect(adultAvatars).toHaveLength(2);
      for (const avatar of adultAvatars) {
        expect(avatar.getAttribute("aria-hidden")).toBe("true");
      }

      // Switch to Minors
      const group = screen.getByRole("group", { name: "Contact types" });
      const minorsBtn = within(group).getByRole("button", { name: "Minors" });
      fireEvent.click(minorsBtn);

      expect(await screen.findByText("Pip")).toBeTruthy();
      // Minors list must have no [data-slot="avatar"] in the page
      const minorAvatars = document.querySelectorAll('[data-slot="avatar"]');
      expect(minorAvatars).toHaveLength(0);
    });

    it("never displays minor data or marker and never requests minors when caller lacks people.restricted.read (restricted must-fail)", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      sessionStorage.setItem("community-hub.community", SLUG);
      const adultPerson1 = {
        id: "adult-1",
        personId: "adult-1",
        isMinor: false,
        givenName: "Mira",
        familyName: "Tolland",
        version: 1,
      };
      const adultPerson2 = {
        id: "adult-2",
        personId: "adult-2",
        isMinor: false,
        givenName: "Owen",
        familyName: "Barrah",
        version: 1,
      };
      const minorPip = {
        id: "minor-1",
        personId: "minor-1",
        isMinor: true,
        givenName: "Pip",
        familyName: "Tolland",
        dateOfBirth: "2016-03-14",
        version: 1,
      };

      const requestedBodies: Record<string, unknown>[] = [];
      const requestedUrls: string[] = [];

      vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
        const url = String(info);
        requestedUrls.push(url);
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        requestedBodies.push(body);

        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({ canReadMinors: false });
        }
        if (path === "/v1/people/list") {
          if (body.kind === "minors") {
            return new Response(JSON.stringify({ items: [minorPip], nextCursor: null }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({ items: [adultPerson1, adultPerson2], nextCursor: null }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(null, { status: 404 });
      });

      await showContacts();

      expect(await screen.findByText("Mira")).toBeTruthy();
      expect(screen.getByText("Owen")).toBeTruthy();

      expect(document.body.textContent).not.toContain("Pip Tolland");
      expect(document.body.textContent).not.toContain("Pip");
      expect(document.body.textContent).not.toContain("2016");
      expect(document.body.textContent).not.toContain("Minors");
      expect(screen.queryByRole("button", { name: "Minors" })).toBeNull();

      for (const body of requestedBodies) {
        expect(body.kind).not.toBe("minors");
        expect(body).not.toHaveProperty("includeRestricted");
      }
      for (const url of requestedUrls) {
        expect(url).not.toContain("minors");
        expect(url).not.toContain("includeRestricted");
      }
    });

    it("lays out the list view in order with Panel, Skeleton, and cursor pagination", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      let resolveFirstList: (value: Response) => void;
      const firstListPromise = new Promise<Response>((resolve) => {
        resolveFirstList = resolve;
      });

      const adultPerson = {
        id: "adult-1",
        personId: "adult-1",
        isMinor: false,
        givenName: "Mira",
        familyName: "Tolland",
        version: 1,
      };

      vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({ canManage: true, canReadMinors: true });
        }
        if (path === "/v1/people/list") {
          if (!body.cursor) {
            return firstListPromise;
          }
          return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(null, { status: 404 });
      });

      await showContacts();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      // While list request is pending, skeleton is shown with aria-hidden="true" and no text
      const skeleton = await waitFor(() => {
        const el = document.querySelector('[data-slot="skeleton"]');
        expect(el).not.toBeNull();
        return el!;
      });
      expect(skeleton.getAttribute("aria-hidden")).toBe("true");
      expect(skeleton.textContent).toBe("");

      // Resolve list request with cursor
      resolveFirstList!(
        new Response(JSON.stringify({ items: [adultPerson], nextCursor: "cursor-page-2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const table = await screen.findByRole("table", { name: "Contacts" });
      expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();

      const panel = table.closest("section");
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute("data-slot")).toBe("panel");

      // Contact types group is outside section, before it
      const contactTypesGroup = screen.getByRole("group", { name: "Contact types" });
      expect(panel?.contains(contactTypesGroup)).toBe(false);
      expect(
        Boolean(
          contactTypesGroup.compareDocumentPosition(panel!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);

      // Panel holds, in document order: Add contact button, search form, Contacts table
      const addBtn = within(panel!).getByRole("button", { name: "Add contact" });
      const searchForm = panel!.querySelector("form");
      expect(searchForm).not.toBeNull();
      expect(
        Boolean(addBtn.compareDocumentPosition(searchForm!) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).toBe(true);
      expect(
        Boolean(searchForm!.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).toBe(true);

      // With a nextCursor, Next page button is inside the section's footer
      const nextBtn = screen.getByRole("button", { name: "Next page" });
      const footer = panel!.querySelector('[data-slot="panel-foot"]');
      expect(footer).not.toBeNull();
      expect(footer?.contains(nextBtn)).toBe(true);

      // Click Next page -> second page has nextCursor: null
      fireEvent.click(nextBtn);
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
      });
      expect(panel!.querySelector('[data-slot="panel-foot"]')).toBeNull();
    });

    it("sets phone data-label attributes on every Contacts table cell", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      const adultPerson = {
        id: "adult-1",
        personId: "adult-1",
        isMinor: false,
        givenName: "Mira",
        familyName: "Tolland",
        version: 1,
      };
      mockApi(
        { canView: true, canManage: true, canReadMinors: false },
        { items: [adultPerson], nextCursor: null },
      );

      await showContacts();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      const table = await screen.findByRole("table", { name: "Contacts" });
      const cells = table.querySelectorAll("td");
      expect(cells.length).toBeGreaterThan(0);

      const allowed = new Set(["Given name", "Family name", "Actions"]);
      for (const cell of cells) {
        const dataLabel = cell.getAttribute("data-label");
        expect(allowed.has(dataLabel ?? "")).toBe(true);
        expect(dataLabel).not.toBe("Mira");
        expect(dataLabel).not.toBe("Tolland");
      }
    });

    it("hides Add contact and shows skeleton while a search request is loading, then shows Add contact once resolved", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      let resolveSearchList: (value: Response) => void;
      const searchListPromise = new Promise<Response>((resolve) => {
        resolveSearchList = resolve;
      });

      const adultPerson1 = {
        id: "adult-1",
        personId: "adult-1",
        isMinor: false,
        givenName: "Doran",
        familyName: "Kite",
        version: 1,
      };
      const adultPerson2 = {
        id: "adult-2",
        personId: "adult-2",
        isMinor: false,
        givenName: "Talia",
        familyName: "Vance",
        version: 1,
      };

      vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({ canManage: true, canView: true, canReadMinors: false });
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
        if (path === "/v1/people/list") {
          if (body.search) {
            return searchListPromise;
          }
          return new Response(JSON.stringify({ items: [adultPerson1], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(null, { status: 404 });
      });

      await showContacts();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("Doran")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Add contact" })).toBeTruthy();

      const searchInput = screen.getByRole("textbox", { name: "Search contacts" });
      fireEvent.change(searchInput, { target: { value: "Vance" } });
      fireEvent.click(screen.getByRole("button", { name: "Search" }));

      await waitFor(() => {
        expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
      });
      expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();

      resolveSearchList!(
        new Response(JSON.stringify({ items: [adultPerson2], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      expect(await screen.findByRole("button", { name: "Add contact" })).toBeTruthy();
      expect(await screen.findByText("Talia")).toBeTruthy();
      expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
    });

    it("hides Add contact after a failed reload", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      const adultPerson = {
        id: "adult-1",
        personId: "adult-1",
        isMinor: false,
        givenName: "Lyle",
        familyName: "Marrow",
        version: 1,
      };

      vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({ canManage: true, canView: true, canReadMinors: false });
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
        if (path === "/v1/people/list") {
          if (body.search) {
            return new Response(null, { status: 500 });
          }
          return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(null, { status: 404 });
      });

      await showContacts();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("Lyle")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Add contact" })).toBeTruthy();

      const searchInput = screen.getByRole("textbox", { name: "Search contacts" });
      fireEvent.change(searchInput, { target: { value: "Marrow" } });
      fireEvent.click(screen.getByRole("button", { name: "Search" }));

      expect(await screen.findByText("Failed to load contacts")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();
    });
  });

  describe("Task 6 Contact Details, add, and edit restyle", () => {
    it("renders Avatar only when isMinor is explicitly false, and omits Avatar when isMinor is missing or true (Pin 27)", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      const personAdult = {
        id: "person-p27-adult",
        personId: "person-p27-adult",
        isMinor: false,
        givenName: "Doran",
        familyName: "Gable",
        version: 1,
      };
      const personMissing = {
        id: "person-p27-missing",
        personId: "person-p27-missing",
        isMinor: false,
        givenName: "Lyra",
        familyName: "Vance",
        version: 1,
      };
      const personMinor = {
        id: "person-p27-minor",
        personId: "person-p27-minor",
        isMinor: true,
        givenName: "Corin",
        familyName: "Sterling",
        version: 1,
      };

      const detailAdult = {
        personId: "person-p27-adult",
        isMinor: false,
        givenName: "Doran",
        familyName: "Gable",
        email: "doran@example.test",
        phone: null,
        dateOfBirth: null,
        version: 1,
      };
      const detailMissing = {
        personId: "person-p27-missing",
        // isMinor omitted
        givenName: "Lyra",
        familyName: "Vance",
        email: "lyra@example.test",
        phone: null,
        dateOfBirth: null,
        version: 1,
      };
      const detailMinor = {
        personId: "person-p27-minor",
        isMinor: true,
        givenName: "Corin",
        familyName: "Sterling",
        email: null,
        phone: null,
        dateOfBirth: null,
        version: 1,
      };

      vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({ canManage: true, canView: true, canReadMinors: true });
        }
        if (path === "/v1/people/list") {
          if (body.kind === "minors") {
            return new Response(JSON.stringify({ items: [personMinor], nextCursor: null }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({ items: [personAdult, personMissing], nextCursor: null }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (path === "/v1/people/read") {
          if (body.personId === "person-p27-adult") {
            return new Response(JSON.stringify(detailAdult), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (body.personId === "person-p27-missing") {
            return new Response(JSON.stringify(detailMissing), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (body.personId === "person-p27-minor") {
            return new Response(JSON.stringify(detailMinor), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
        }
        return new Response(null, { status: 404 });
      });

      await showContacts();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      // Case 1: isMinor is false -> exactly one avatar shows with aria-hidden="true"
      expect(await screen.findByText("Doran")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "View Doran Gable" }));
      expect(
        await screen.findByRole("heading", { name: "Contact Details", level: 2 }),
      ).toBeTruthy();
      expect(await screen.findByText("doran@example.test")).toBeTruthy();
      const avatarsAdult = document.querySelectorAll('[data-slot="avatar"]');
      expect(avatarsAdult).toHaveLength(1);
      expect(avatarsAdult[0]?.getAttribute("aria-hidden")).toBe("true");

      // Back to list
      fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
      expect(await screen.findByText("Lyra")).toBeTruthy();

      // Case 2: isMinor is missing -> no avatar shows
      fireEvent.click(screen.getByRole("button", { name: "View Lyra Vance" }));
      expect(
        await screen.findByRole("heading", { name: "Contact Details", level: 2 }),
      ).toBeTruthy();
      expect(await screen.findByText("lyra@example.test")).toBeTruthy();
      expect(document.querySelectorAll('[data-slot="avatar"]')).toHaveLength(0);

      // Back to list, switch to minors tab
      fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
      const minorsTab = await screen.findByRole("button", { name: "Minors" });
      fireEvent.click(minorsTab);

      // Case 3: isMinor is true -> no avatar shows
      expect(await screen.findByText("Corin")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "View Corin Sterling" }));
      expect(
        await screen.findByRole("heading", { name: "Contact Details", level: 2 }),
      ).toBeTruthy();
      expect(await screen.findByText("Corin")).toBeTruthy();
      expect(document.querySelectorAll('[data-slot="avatar"]')).toHaveLength(0);
    });

    it("shows Edit contact when isMinor is missing from detail response", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      const personMissing = {
        id: "person-edit-missing",
        personId: "person-edit-missing",
        isMinor: false,
        givenName: "Bram",
        familyName: "Calder",
        version: 1,
      };
      const detailMissing = {
        personId: "person-edit-missing",
        // isMinor omitted
        givenName: "Bram",
        familyName: "Calder",
        email: "bram@example.test",
        phone: null,
        dateOfBirth: null,
        version: 1,
      };

      vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");

        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({ canManage: true, canView: true, canReadMinors: false });
        }
        if (path === "/v1/people/list") {
          return new Response(JSON.stringify({ items: [personMissing], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (path === "/v1/people/read") {
          return new Response(JSON.stringify(detailMissing), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(null, { status: 404 });
      });

      await showContacts();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("Bram")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "View Bram Calder" }));

      expect(
        await screen.findByRole("heading", { name: "Contact Details", level: 2 }),
      ).toBeTruthy();
      expect(await screen.findByRole("button", { name: "Edit contact" })).toBeTruthy();
    });

    it("keeps Contact Details level 2 heading mounted while loading, on 404, and on failed load", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      const personItem = {
        id: "person-heading-1",
        personId: "person-heading-1",
        isMinor: false,
        givenName: "Elora",
        familyName: "Quinn",
        version: 1,
      };

      let resolvePending: ((res: Response) => void) | undefined;
      let readStatus: "pending" | "404" | "500" = "pending";

      vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");

        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({ canManage: true, canView: true, canReadMinors: false });
        }
        if (path === "/v1/people/list") {
          return new Response(JSON.stringify({ items: [personItem], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (path === "/v1/people/read") {
          if (readStatus === "pending") {
            return new Promise<Response>((resolve) => {
              resolvePending = resolve;
            });
          }
          if (readStatus === "404") {
            return new Response(null, { status: 404 });
          }
          if (readStatus === "500") {
            return new Response(null, { status: 500 });
          }
        }
        return new Response(null, { status: 404 });
      });

      await showContacts();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("Elora")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "View Elora Quinn" }));

      // 1. While loading / pending
      expect(screen.getByRole("heading", { name: "Contact Details", level: 2 })).toBeTruthy();

      // 2. Resolve as 404 ("Contact not found")
      resolvePending!(new Response(null, { status: 404 }));
      expect(await screen.findByText("Contact not found")).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Contact Details", level: 2 })).toBeTruthy();

      // 3. Failed load ("Failed to load contact")
      readStatus = "500";
      fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
      expect(await screen.findByText("Elora")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "View Elora Quinn" }));

      expect(await screen.findByText("Failed to load contact")).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Contact Details", level: 2 })).toBeTruthy();
    });

    it("shows skeleton with aria-hidden and Loading contact details in a plain sr-only span with no role or aria-live while loading", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      const personItem = {
        id: "person-loading-1",
        personId: "person-loading-1",
        isMinor: false,
        givenName: "Thane",
        familyName: "Rennick",
        version: 1,
      };

      let resolvePending: ((res: Response) => void) | undefined;

      vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");

        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({ canManage: true, canView: true, canReadMinors: false });
        }
        if (path === "/v1/people/list") {
          return new Response(JSON.stringify({ items: [personItem], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (path === "/v1/people/read") {
          return new Promise<Response>((resolve) => {
            resolvePending = resolve;
          });
        }
        return new Response(null, { status: 404 });
      });

      await showContacts();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("Thane")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "View Thane Rennick" }));

      const skeleton = await waitFor(() => {
        const el = document.querySelector('[data-slot="skeleton"]');
        expect(el).not.toBeNull();
        return el!;
      });
      expect(skeleton.getAttribute("aria-hidden")).toBe("true");

      const loadingText = screen.getByText("Loading contact details...");
      expect(loadingText.tagName.toLowerCase()).toBe("span");
      expect(loadingText.classList.contains("sr-only")).toBe(true);
      expect(loadingText.getAttribute("role")).toBeNull();
      expect(loadingText.getAttribute("aria-live")).toBeNull();

      const panel = document.querySelector('[data-slot="panel"]');
      expect(panel).not.toBeNull();
      let current: HTMLElement | null = loadingText.parentElement;
      while (current && current !== panel) {
        expect(current.getAttribute("role")).toBeNull();
        expect(current.getAttribute("aria-live")).toBeNull();
        current = current.parentElement;
      }
      expect(panel?.getAttribute("role")).toBeNull();
      expect(panel?.getAttribute("aria-live")).toBeNull();

      resolvePending!(new Response(null, { status: 404 }));
      await screen.findByText("Contact not found");
    });

    it("renders dt labels in order with colons, and shows None for missing email, phone, and date of birth", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      const personItem = {
        id: "person-labels-1",
        personId: "person-labels-1",
        isMinor: false,
        givenName: "Kaelen",
        familyName: "Vex",
        version: 1,
      };
      const detailItem = {
        personId: "person-labels-1",
        isMinor: false,
        givenName: "Kaelen",
        familyName: "Vex",
        email: null,
        phone: null,
        dateOfBirth: null,
        version: 1,
      };

      vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");

        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({ canManage: true, canView: true, canReadMinors: false });
        }
        if (path === "/v1/people/list") {
          return new Response(JSON.stringify({ items: [personItem], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (path === "/v1/people/read") {
          return new Response(JSON.stringify(detailItem), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(null, { status: 404 });
      });

      await showContacts();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("Kaelen")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "View Kaelen Vex" }));

      expect(
        await screen.findByRole("heading", { name: "Contact Details", level: 2 }),
      ).toBeTruthy();
      await screen.findByText("Given name:");

      const dts = Array.from(document.querySelectorAll('[data-slot="panel"] dt'));
      expect(dts.map((dt) => dt.textContent?.trim())).toEqual([
        "Given name:",
        "Family name:",
        "Email:",
        "Phone:",
        "Date of birth:",
      ]);

      const dds = Array.from(document.querySelectorAll('[data-slot="panel"] dd'));
      expect(dds).toHaveLength(5);
      expect(dds[0]?.textContent?.trim()).toBe("Kaelen");
      expect(dds[1]?.textContent?.trim()).toBe("Vex");
      expect(dds[2]?.textContent?.trim()).toBe("None");
      expect(dds[3]?.textContent?.trim()).toBe("None");
      expect(dds[4]?.textContent?.trim()).toBe("None");

      for (const index of [2, 3, 4]) {
        const span = dds[index]?.querySelector("span");
        expect(span?.classList.contains("text-muted-foreground")).toBe(true);
        expect(span?.textContent).toBe("None");
      }
    });

    it("hides Edit contact and Avatar when update returns 404 and Contact not found is shown", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      const adultContact = {
        id: "person-saved-gone-1",
        personId: "person-saved-gone-1",
        isMinor: false,
        givenName: "Tamsin",
        familyName: "Drake",
        version: 1,
      };
      const adultContactDetail = {
        personId: "person-saved-gone-1",
        householdId: null,
        isMinor: false,
        givenName: "Tamsin",
        familyName: "Drake",
        email: "tamsin@example.test",
        phone: null,
        dateOfBirth: null,
        version: 1,
      };

      vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");

        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({ canManage: true, canView: true, canReadMinors: false });
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
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (path === "/v1/people/list") {
          return new Response(JSON.stringify({ items: [adultContact], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (path === "/v1/people/read") {
          return new Response(JSON.stringify(adultContactDetail), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (path === "/v1/people/update") {
          return new Response(null, { status: 404 });
        }
        return new Response(null, { status: 404 });
      });

      await showContacts();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(await screen.findByText("Tamsin")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "View Tamsin Drake" }));

      expect(
        await screen.findByRole("heading", { name: "Contact Details", level: 2 }),
      ).toBeTruthy();
      expect(await screen.findByRole("button", { name: "Edit contact" })).toBeTruthy();
      expect(document.querySelectorAll('[data-slot="avatar"]')).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Edit contact" }));
      expect(await screen.findByRole("heading", { name: "Edit Contact", level: 2 })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      expect(await screen.findByText("Contact not found")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Edit contact" })).toBeNull();
      expect(document.querySelectorAll('[data-slot="avatar"]')).toHaveLength(0);
    });
  });
});
