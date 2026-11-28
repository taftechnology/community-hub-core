import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { router, Shell } from "./shell";
import { PERSON_SOURCES, PERSON_SOURCE_LABELS } from "./all-contacts";

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

// A child in the Community Admin's list: the display label and the family, and nothing else.
function childRow(n: number, family: string | null = "Clarke Family") {
  return {
    personId: `00000000-0000-4000-8000-00000000010${n}`,
    label: `Child ${n}`,
    householdId: "00000000-0000-4000-8000-000000000200",
    householdLabel: family,
  };
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
  vi.useRealTimers();
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

  it("Minors tab is hidden for a caller the service refuses the children's list, even with people.restricted.read (Pin 93)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const minorsCalls: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const path = String(info).replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        if (body.kind === "minors") {
          minorsCalls.push(body);
          // Only a Community Admin is answered. A safeguarding officer, or an organisation admin
          // who is not also a Community Admin here, holds the same keys and is refused.
          return new Response(null, { status: 403 });
        }
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

    await screen.findByText("No contacts yet");
    // The service has answered the question of who may see the children.
    await waitFor(() => expect(minorsCalls).toHaveLength(1));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Minors" })).toBeNull();
    expect(minorsCalls[0]).toEqual({ communitySlug: SLUG, kind: "minors", limit: 1 });
  });

  it("Minors tab appears only with people.restricted.read: without it nothing about children is asked (Pin 15)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const minorsCalls: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const path = String(info).replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({
          directoryEnabled: true,
          canView: true,
          canManage: true,
          canReadMinors: false,
        });
      }
      if (path === "/v1/people/list") {
        if (body.kind === "minors") {
          minorsCalls.push(body);
        }
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

    await screen.findByText("No contacts yet");
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Minors" })).toBeNull();
    expect(screen.queryByText("Minors")).toBeNull();
    expect(minorsCalls).toHaveLength(0);
  });

  it("Minors tab is hidden without people.households, even for a Community Admin the service would answer (Pin 94)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const minorsCalls: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const path = String(info).replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse({
          directoryEnabled: true,
          householdsEnabled: false,
          canView: true,
          canManage: true,
          canReadMinors: true,
        });
      }
      if (path === "/v1/people/list") {
        if (body.kind === "minors") {
          minorsCalls.push(body);
          return new Response(JSON.stringify({ items: [childRow(1)], nextCursor: null }), {
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
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await screen.findByText("No contacts yet");
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Minors" })).toBeNull();
    expect(minorsCalls).toHaveLength(0);
  });

  it("a Community Admin sees the Minors tab, and its rows are labels with the family and no fields (Pin 93)", async () => {
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
        if (body.kind === "minors") {
          if (body.limit === undefined) {
            capturedKind = body.kind;
          }
          return new Response(
            JSON.stringify({
              items: [childRow(1), childRow(2, null)],
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
    const minorsBtn = await within(group).findByRole("button", { name: "Minors" });
    expect(adultsBtn.getAttribute("aria-pressed")).toBe("true");
    expect(minorsBtn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(minorsBtn);

    expect(await screen.findByText("Child 1")).toBeTruthy();
    expect(screen.getByText("Child 2")).toBeTruthy();
    expect(capturedKind).toBe("minors");
    expect(adultsBtn.getAttribute("aria-pressed")).toBe("false");
    expect(minorsBtn.getAttribute("aria-pressed")).toBe("true");

    // The rows are the label and the family, and nothing else: no field, and nothing to open.
    expect(screen.getByText("Clarke Family")).toBeTruthy();
    expect(screen.getByText("No family name")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Children" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Child", "Family"]);
    expect(within(table).queryAllByRole("button")).toHaveLength(0);

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("a refresh of the same community keeps the Minors tab, and the view on it", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const path = String(info).replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        return new Response(
          JSON.stringify({
            items: body.kind === "minors" ? [childRow(1)] : [],
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

    const minorsBtn = await screen.findByRole("button", { name: "Minors" });
    fireEvent.click(minorsBtn);
    expect(await screen.findByText("Child 1")).toBeTruthy();

    // Setting the same community again asks everything again.
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    await act(async () => {});
    expect(await screen.findByText("Child 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Minors" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
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
              items: [childRow(1)],
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
    const minorsBtn = await within(group).findByRole("button", { name: "Minors" });

    expect(await screen.findByText("Adult")).toBeTruthy();
    const callsAfterAdultsLoad = listCallCount;
    expect(callsAfterAdultsLoad).toBeGreaterThanOrEqual(1);

    // Clicking already-active Adults tab must keep list and not make requests
    fireEvent.click(adultsBtn);
    expect(screen.queryByText("Adult")).toBeTruthy();
    expect(listCallCount).toBe(callsAfterAdultsLoad);

    // Switch to Minors
    fireEvent.click(minorsBtn);
    expect(await screen.findByText("Child 1")).toBeTruthy();
    const callsAfterMinorsLoad = listCallCount;

    // Clicking already-active Minors tab must keep list and not make requests
    fireEvent.click(minorsBtn);
    expect(screen.queryByText("Child 1")).toBeTruthy();
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

    const minorsTab = await screen.findByRole("button", { name: "Minors" });
    fireEvent.click(minorsTab);

    // Minors tab must NOT render the search box
    expect(screen.queryByRole("textbox", { name: "Search contacts" })).toBeNull();

    await waitFor(() =>
      expect(recordedBodies.some((b) => b.kind === "minors" && b.limit === undefined)).toBe(true),
    );
    // The one question that decides whether the tab shows has a limit of one. Every call that lists
    // the children for the tab itself has no search and no limit.
    const minorsCalls = recordedBodies.filter((b) => b.kind === "minors");
    const tabCalls = minorsCalls.filter((b) => b.limit === undefined);
    expect(tabCalls.length).toBeGreaterThanOrEqual(1);
    for (const body of tabCalls) {
      expect(body.search).toBeUndefined();
      expect(Object.keys(body).sort()).toEqual(["communitySlug", "kind"].sort());
    }
    for (const body of minorsCalls.filter((b) => b.limit !== undefined)) {
      expect(Object.keys(body).sort()).toEqual(["communitySlug", "kind", "limit"].sort());
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
    const minorsTab = await screen.findByRole("button", { name: "Minors" });
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
      if (body.kind === "minors" && body.limit === 1) {
        // The question of whether this caller may see the children, asked afresh for each community.
        continue;
      }
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
    const minorsBtn = await within(group).findByRole("button", { name: "Minors" });

    fireEvent.click(minorsBtn);
    expect(minorsBtn.getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(communityInput, { target: { value: "community-b" } });
    fireEvent.click(setButton);

    await waitFor(() => expect(recordedKinds.length).toBeGreaterThanOrEqual(1));
    expect(adultsBtn.getAttribute("aria-pressed")).toBe("true");
    // The tab goes with the community and comes back when the service says this caller may see it.
    const minorsAgain = await within(group).findByRole("button", { name: "Minors" });
    expect(minorsAgain.getAttribute("aria-pressed")).toBe("false");
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

  it("never provides a create, edit or open control for a child, and never reads one as a contact", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const paths: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      paths.push(path);
      if (path === "/v1/access/capabilities") {
        return mockCapabilitiesResponse();
      }
      if (path === "/v1/people/list") {
        return new Response(JSON.stringify({ items: [childRow(1)], nextCursor: null }), {
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

    expect(await screen.findByText("Child 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();
    // A child is a label: there is no View, no Edit, and nothing that opens a contact.
    expect(screen.queryByRole("button", { name: /^View/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit contact" })).toBeNull();
    expect(paths).not.toContain("/v1/people/read");
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
      const minorPerson1 = childRow(1, "Tolland");

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
      const minorsBtn = await within(group).findByRole("button", { name: "Minors" });
      fireEvent.click(minorsBtn);

      expect(await screen.findByText("Child 1")).toBeTruthy();
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

      const allowed = new Set([
        "Given name",
        "Family name",
        "Name",
        "Email",
        "Phone",
        "Date",
        "Groups",
        "Source",
        "Status",
        "Actions",
      ]);
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
      // A row of the adults' list whose detail says it is a minor: the screen must still show no
      // avatar for it, whatever sent it here.
      const personMinor = {
        id: "person-p27-minor",
        personId: "person-p27-minor",
        isMinor: false,
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
            return new Response(JSON.stringify({ items: [], nextCursor: null }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({ items: [personAdult, personMissing, personMinor], nextCursor: null }),
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

      // Back to list
      fireEvent.click(screen.getByRole("button", { name: "Back to list" }));

      // Case 3: the detail says isMinor is true -> no avatar shows
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

    it("spaces the Adults and Minors buttons with flex flex-wrap gap-2", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      mockApi({ directoryEnabled: true, canView: true, canManage: true, canReadMinors: true });

      await showContacts();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      const group = await screen.findByRole("group", { name: "Contact types" });
      expect(group.className).toContain("flex");
      expect(group.className).toContain("flex-wrap");
      expect(group.className).toContain("gap-2");
    });

    it("gives the Back to list button justify-self-start self-start in detail view", async () => {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse({
            directoryEnabled: true,
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
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (path === "/v1/people/list") {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "p-1",
                  personId: "p-1",
                  givenName: "Mira",
                  familyName: "Tolland",
                  isMinor: false,
                },
              ],
              nextCursor: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (path === "/v1/people/read") {
          return new Response(
            JSON.stringify({
              personId: "p-1",
              givenName: "Mira",
              familyName: "Tolland",
              email: "mira@example.test",
              phone: null,
              dateOfBirth: null,
              isMinor: false,
              version: 1,
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

      expect(await screen.findByText("Mira")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "View Mira Tolland" }));
      expect(
        await screen.findByRole("heading", { name: "Contact Details", level: 2 }),
      ).toBeTruthy();

      const backButton = screen.getByRole("button", { name: "Back to list" });
      expect(backButton.className).toContain("justify-self-start");
      expect(backButton.className).toContain("self-start");
    });

    it("uses the small size for buttons inside table rows", async () => {
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
      const buttons = table.querySelectorAll("button");
      expect(buttons.length).toBeGreaterThan(0);
      for (const btn of buttons) {
        expect(btn.className).toContain("h-(--ch-size-control-sm)");
      }
    });
  });

  describe("All Contacts parity screen", () => {
    type ParityApiOptions = {
      access?: CapabilitiesInput;
      billingStatus?: { state: string; canView: boolean; canManage: boolean } | number;
      listResult?:
        | { items: unknown[]; nextCursor: string | null }
        | number
        | ((body: unknown) => Response | Promise<Response>);
      summaryResult?: unknown | number | ((body: unknown) => Response | Promise<Response>);
      statusResult?: unknown | number | ((body: unknown) => Response | Promise<Response>);
      readResult?: unknown | number;
      updateResult?: unknown | number;
      createResult?: unknown | number;
      onPost?: (path: string, body: unknown) => void;
    };

    function mockParityApi(options: ParityApiOptions = {}) {
      const calls: { path: string; body: unknown }[] = [];

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
        const url = String(info);
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        let body: unknown = undefined;
        if (init?.body) {
          try {
            body = JSON.parse(String(init.body));
          } catch {
            body = init.body;
          }
        }
        calls.push({ path, body });
        options.onPost?.(path, body);

        if (path === "/v1/access/capabilities") {
          return mockCapabilitiesResponse(options.access ?? {});
        }

        if (path === "/v1/billing/status") {
          const billing = options.billingStatus ?? {
            state: "ok",
            canView: true,
            canManage: true,
          };
          if (typeof billing === "number") {
            return new Response(null, { status: billing });
          }
          return new Response(
            JSON.stringify({
              trial_end: null,
              grace_until: null,
              ...billing,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if (path === "/v1/people/list") {
          if (typeof options.listResult === "function") {
            return options.listResult(body);
          }
          const result = options.listResult ?? { items: [], nextCursor: null };
          if (typeof result === "number") {
            return new Response(null, { status: result });
          }
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (path === "/v1/people/summary") {
          if (typeof options.summaryResult === "function") {
            return options.summaryResult(body);
          }
          const result = options.summaryResult ?? {
            total: 0,
            active: 0,
            inactive: 0,
            addedSince: 0,
          };
          if (typeof result === "number") {
            return new Response(null, { status: result });
          }
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (path === "/v1/people/status") {
          if (typeof options.statusResult === "function") {
            return options.statusResult(body);
          }
          const result = options.statusResult ?? { version: 2, status: "inactive" };
          if (typeof result === "number") {
            return new Response(null, { status: result });
          }
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (path === "/v1/people/read") {
          const result = options.readResult ?? {
            personId: "00000000-0000-4000-8000-000000000001",
            isMinor: false,
            givenName: "Ada",
            familyName: "Lovelace",
            email: "ada@example.test",
            phone: "+61 400 555 001",
            dateOfBirth: "1980-01-01",
            version: 1,
            status: "active",
            source: "manual",
          };
          if (typeof result === "number") {
            return new Response(null, { status: result });
          }
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (path === "/v1/people/create") {
          const result = options.createResult ?? {
            personId: "00000000-0000-4000-8000-000000000001",
          };
          if (typeof result === "number") {
            return new Response(null, { status: result });
          }
          return new Response(JSON.stringify(result), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }

        if (path === "/v1/people/update") {
          const result = options.updateResult ?? { version: 2 };
          if (typeof result === "number") {
            return new Response(null, { status: result });
          }
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(null, { status: 404 });
      });

      return { fetchSpy, calls };
    }

    async function openAllContactsPage() {
      sessionStorage.setItem("community-hub.access-token", TOKEN);
      const container = await showContacts();
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: SLUG },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));
      await screen.findByRole("heading", { name: "All Contacts" });
      return container;
    }

    it("All Contacts: billing read-only shows a status badge, not a switch", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        email: "ada@example.test",
        phone: "+61 400 555 001",
        age: 42,
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: true },
        billingStatus: { state: "read_only", canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
      });

      await openAllContactsPage();
      const table = await screen.findByRole("table", { name: "Contacts" });

      expect(screen.queryByRole("switch")).toBeNull();
      const badge = within(table).getByText("Active");
      expect(badge).toBeTruthy();
      expect(badge.getAttribute("data-slot")).toBe("status-badge");
    });

    it("All Contacts: without people.manage the status is a badge", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        email: "ada@example.test",
        phone: "+61 400 555 001",
        age: 42,
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: false },
        billingStatus: { state: "ok", canView: true, canManage: false },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
      });

      await openAllContactsPage();
      const table = await screen.findByRole("table", { name: "Contacts" });

      expect(screen.queryByRole("switch")).toBeNull();
      const badge = within(table).getByText("Active");
      expect(badge).toBeTruthy();
      expect(badge.getAttribute("data-slot")).toBe("status-badge");
    });

    it("All Contacts: no groups key in the summary hides the Groups column and filter", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        email: "ada@example.test",
        phone: "+61 400 555 001",
        age: 42,
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      expect(screen.queryByRole("columnheader", { name: "Groups" })).toBeNull();
      expect(screen.queryByLabelText("Group")).toBeNull();
    });

    it("All Contacts: a 409 on the switch reloads the list and shows the changed alert", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        email: "ada@example.test",
        phone: "+61 400 555 001",
        age: 42,
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      const { calls } = mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
        statusResult: 409,
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      const switchEl = screen.getByRole("switch", { name: /Ada Lovelace/ }) as HTMLInputElement;
      expect(switchEl.checked).toBe(true);

      const listCallsBefore = calls.filter((c) => c.path === "/v1/people/list").length;

      fireEvent.click(switchEl);

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/changed/i);

      await waitFor(() => {
        const listCallsAfter = calls.filter((c) => c.path === "/v1/people/list").length;
        expect(listCallsAfter).toBe(listCallsBefore + 1);
      });
    });

    it("All Contacts: editing a contact with an automatic source sends no source unless one is picked", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        email: "ada@example.test",
        phone: "+61 400 555 001",
        age: 42,
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "auto",
        version: 1,
      };
      const { calls } = mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
        readResult: {
          personId: adultPerson.id,
          isMinor: false,
          givenName: "Ada",
          familyName: "Lovelace",
          email: "ada@example.test",
          phone: "+61 400 555 001",
          dateOfBirth: "1980-01-01",
          version: 1,
          status: "active",
          source: "auto",
        },
        updateResult: { version: 2 },
      });

      await openAllContactsPage();
      fireEvent.click(await screen.findByRole("button", { name: "View Ada Lovelace" }));
      fireEvent.click(await screen.findByRole("button", { name: "Edit contact" }));

      const sourceSelect = await screen.findByLabelText<HTMLSelectElement>("Source");
      expect(sourceSelect.value).toBe("keep");
      expect(sourceSelect.options[0]?.textContent).toBe("Keep current (Auto)");

      // Save without changing source
      fireEvent.change(screen.getByLabelText("Given name"), { target: { value: "Adalyn" } });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => {
        const updateCalls = calls.filter((c) => c.path === "/v1/people/update");
        expect(updateCalls.length).toBe(1);
        const updateBody = updateCalls[0]?.body as Record<string, unknown>;
        expect(updateBody.source).toBeUndefined();
      });

      // Edit again and pick Manual
      fireEvent.click(await screen.findByRole("button", { name: "Edit contact" }));
      const sourceSelect2 = await screen.findByLabelText<HTMLSelectElement>("Source");
      fireEvent.change(sourceSelect2, { target: { value: "manual" } });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => {
        const updateCalls = calls.filter((c) => c.path === "/v1/people/update");
        expect(updateCalls.length).toBe(2);
        const updateBody2 = updateCalls[1]?.body as Record<string, unknown>;
        expect(updateBody2.source).toBe("manual");
      });
    });

    it("renders adults table columns in the board order", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        email: "ada@example.test",
        phone: "+61 400 555 001",
        age: 42,
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        groups: [{ id: "00000000-0000-4000-8000-000000000010", name: "Choir" }],
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: {
          total: 1,
          active: 1,
          inactive: 0,
          addedSince: 1,
          groups: [{ id: "00000000-0000-4000-8000-000000000010", name: "Choir" }],
        },
      });

      const container = await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      const headers = screen.getAllByRole("columnheader").map((th) => th.textContent?.trim());
      expect(headers).toEqual([
        "Name",
        "Email",
        "Phone",
        "Date",
        "Groups",
        "Source",
        "Status",
        "Actions",
      ]);

      const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
      expect(resultIds(results, "violations")).toEqual([]);
    });

    it("renders age under the name when known", async () => {
      const withAge = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        age: 42,
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      const withoutAge = {
        id: "00000000-0000-4000-8000-000000000002",
        personId: "00000000-0000-4000-8000-000000000002",
        isMinor: false,
        givenName: "Charles",
        familyName: "Babbage",
        age: null,
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [withAge, withoutAge], nextCursor: null },
        summaryResult: { total: 2, active: 2, inactive: 0, addedSince: 2 },
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      expect(screen.getByText("42 years old")).toBeTruthy();
      expect(screen.queryByText(/years old/g)?.textContent).toBe("42 years old");
    });

    it("renders 'None' for empty email, phone and groups", async () => {
      const emptyDetails = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        email: null,
        phone: null,
        age: null,
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        groups: [],
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [emptyDetails], nextCursor: null },
        summaryResult: {
          total: 1,
          active: 1,
          inactive: 0,
          addedSince: 1,
          groups: [{ id: "00000000-0000-4000-8000-000000000010", name: "Choir" }],
        },
      });

      await openAllContactsPage();
      const table = await screen.findByRole("table", { name: "Contacts" });

      const noneElements = within(table).getAllByText("None");
      expect(noneElements.length).toBeGreaterThanOrEqual(3);
    });

    it("filters reset the cursor and are sent in the list body", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      const { calls } = mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: "next-cursor-1" },
        summaryResult: {
          total: 10,
          active: 8,
          inactive: 2,
          addedSince: 3,
          groups: [{ id: "00000000-0000-4000-8000-000000000010", name: "Youth" }],
        },
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      // Navigate to page 2
      fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
      await waitFor(() => {
        const pageCalls = calls.filter((c) => c.path === "/v1/people/list");
        const lastCall = pageCalls[pageCalls.length - 1];
        const body = lastCall?.body as Record<string, unknown>;
        expect(body.cursor).toBe("next-cursor-1");
      });

      // Change status filter
      const statusSelect = screen.getByLabelText("Status");
      fireEvent.change(statusSelect, { target: { value: "inactive" } });

      await waitFor(() => {
        const filterCalls = calls.filter((c) => c.path === "/v1/people/list");
        const lastCall = filterCalls[filterCalls.length - 1];
        const body = lastCall?.body as Record<string, unknown>;
        expect(body.status).toBe("inactive");
        expect(body.cursor).toBeUndefined();
      });

      // Change source filter
      const sourceSelect = screen.getByLabelText("Source");
      fireEvent.change(sourceSelect, { target: { value: "website" } });

      await waitFor(() => {
        const filterCalls = calls.filter((c) => c.path === "/v1/people/list");
        const lastCall = filterCalls[filterCalls.length - 1];
        const body = lastCall?.body as Record<string, unknown>;
        expect(body.source).toBe("website");
        expect(body.cursor).toBeUndefined();
      });

      // Change group filter
      const groupSelect = screen.getByLabelText("Group");
      fireEvent.change(groupSelect, { target: { value: "00000000-0000-4000-8000-000000000010" } });

      await waitFor(() => {
        const filterCalls = calls.filter((c) => c.path === "/v1/people/list");
        const lastCall = filterCalls[filterCalls.length - 1];
        const body = lastCall?.body as Record<string, unknown>;
        expect(body.groupId).toBe("00000000-0000-4000-8000-000000000010");
        expect(body.cursor).toBeUndefined();
      });
    });

    it("renders the four count cards from the summary", async () => {
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [], nextCursor: null },
        summaryResult: {
          total: 150,
          active: 130,
          inactive: 20,
          addedSince: 12,
        },
      });

      await openAllContactsPage();
      const cards = (await screen.findByText("Total contacts")).closest("div.grid") as HTMLElement;
      expect(within(cards).getByText("Total contacts")).toBeTruthy();
      expect(within(cards).getByText("150")).toBeTruthy();
      expect(within(cards).getByText("Active")).toBeTruthy();
      expect(within(cards).getByText("130")).toBeTruthy();
      expect(within(cards).getByText("Inactive")).toBeTruthy();
      expect(within(cards).getByText("20")).toBeTruthy();
      expect(within(cards).getByText("Added this month")).toBeTruthy();
      expect(within(cards).getByText("12")).toBeTruthy();
    });

    it("displays 'Counts unavailable' on a summary failure while leaving the list working", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: 500,
      });

      await openAllContactsPage();
      expect(await screen.findByText("Counts unavailable")).toBeTruthy();

      expect(await screen.findByRole("table", { name: "Contacts" })).toBeTruthy();
      expect(screen.getByText("Ada")).toBeTruthy();
      expect(screen.queryByRole("columnheader", { name: "Groups" })).toBeNull();
      expect(screen.queryByLabelText("Group")).toBeNull();
    });

    it("the switch accessible name includes the contact name and its visible label stays 'Active'", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      const switchEl = screen.getByRole("switch", { name: /Ada Lovelace/ });
      expect(switchEl).toBeTruthy();
      expect(switchEl.closest("label")?.textContent).toContain("Active");
    });

    it("disables the status switch while saving", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      let releaseStatus: (res: Response) => void = () => {};
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
        statusResult: () =>
          new Promise<Response>((resolve) => {
            releaseStatus = resolve;
          }),
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      const switchEl = screen.getByRole("switch", { name: /Ada Lovelace/ }) as HTMLInputElement;
      expect(switchEl.disabled).toBe(false);

      fireEvent.click(switchEl);
      expect(switchEl.disabled).toBe(true);

      await act(async () => {
        releaseStatus(
          new Response(JSON.stringify({ version: 2, status: "inactive" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      });

      await waitFor(() => {
        expect(switchEl.disabled).toBe(false);
      });
    });

    it("a non-409 failure returns the switch and shows an alert", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
        statusResult: 500,
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      const switchEl = screen.getByRole("switch", { name: /Ada Lovelace/ }) as HTMLInputElement;
      expect(switchEl.checked).toBe(true);

      fireEvent.click(switchEl);

      const alert = await screen.findByRole("alert");
      expect(alert).toBeTruthy();
      expect(switchEl.checked).toBe(true);
    });

    it("filter with no match shows 'No contacts match these filters' with Clear filters button which resets filters", async () => {
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [], nextCursor: null },
        summaryResult: { total: 10, active: 8, inactive: 2, addedSince: 3 },
      });

      await openAllContactsPage();
      const statusSelect = (await screen.findByLabelText("Status")) as HTMLSelectElement;
      fireEvent.change(statusSelect, { target: { value: "inactive" } });

      expect(await screen.findByText("No contacts match these filters")).toBeTruthy();
      const clearBtn = screen.getByRole("button", { name: "Clear filters" });
      expect(clearBtn).toBeTruthy();

      fireEvent.click(clearBtn);
      expect(statusSelect.value).toBe("");
    });

    it("the Source select on add and edit with 'Keep current (<label>)' for an automatic source", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "mobile_app",
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
        readResult: {
          personId: adultPerson.id,
          isMinor: false,
          givenName: "Ada",
          familyName: "Lovelace",
          email: "ada@example.test",
          phone: "+61 400 555 001",
          dateOfBirth: "1980-01-01",
          version: 1,
          status: "active",
          source: "mobile_app",
        },
      });

      await openAllContactsPage();

      // Check Add form
      fireEvent.click(await screen.findByRole("button", { name: "Add contact" }));
      const addSourceSelect = await screen.findByLabelText<HTMLSelectElement>("Source");
      expect(addSourceSelect.value).toBe("manual");
      const addOptions = Array.from(addSourceSelect.options).map((o) => o.textContent);
      expect(addOptions).toEqual(["Manual", "Family Records"]);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      // Check Edit form
      fireEvent.click(await screen.findByRole("button", { name: "View Ada Lovelace" }));
      fireEvent.click(await screen.findByRole("button", { name: "Edit contact" }));
      const editSourceSelect = await screen.findByLabelText<HTMLSelectElement>("Source");
      expect(editSourceSelect.value).toBe("keep");
      expect(editSourceSelect.options[0]?.textContent).toBe("Keep current (Mobile App)");
      const editOptions = Array.from(editSourceSelect.options).map((o) => o.textContent);
      expect(editOptions).toEqual(["Keep current (Mobile App)", "Manual", "Family Records"]);
    });

    it("All Contacts: the switch sends the new status and the row's version, in both directions", async () => {
      const activePerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        email: "ada@example.test",
        phone: "+61 400 555 001",
        age: 42,
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      let statusCallCount = 0;
      const { calls } = mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [activePerson], nextCursor: null },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
        statusResult: (body: unknown) => {
          statusCallCount++;
          const parsed = body as Record<string, unknown>;
          if (statusCallCount === 1) {
            return new Response(JSON.stringify({ version: 2, status: parsed.status }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ version: 3, status: parsed.status }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      const switchEl = screen.getByRole("switch", { name: /Ada Lovelace/ }) as HTMLInputElement;
      expect(switchEl.checked).toBe(true);

      // Direction 1: Active -> Inactive
      fireEvent.click(switchEl);
      await waitFor(() => {
        const statusCalls = calls.filter((c) => c.path === "/v1/people/status");
        expect(statusCalls.length).toBe(1);
        const body1 = statusCalls[0]?.body as Record<string, unknown>;
        expect(body1.personId).toBe(activePerson.id);
        expect(body1.communitySlug).toBe(SLUG);
        expect(body1.version).toBe(1);
        expect(body1.status).toBe("inactive");
      });

      await waitFor(() => {
        expect(switchEl.checked).toBe(false);
      });

      // Direction 2: Inactive -> Active
      fireEvent.click(switchEl);
      await waitFor(() => {
        const statusCalls = calls.filter((c) => c.path === "/v1/people/status");
        expect(statusCalls.length).toBe(2);
        const body2 = statusCalls[1]?.body as Record<string, unknown>;
        expect(body2.personId).toBe(activePerson.id);
        expect(body2.communitySlug).toBe(SLUG);
        expect(body2.version).toBe(2);
        expect(body2.status).toBe("active");
      });
    });

    it("All Contacts: the add form sends the picked source", async () => {
      const { calls } = mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [], nextCursor: null },
        summaryResult: { total: 0, active: 0, inactive: 0, addedSince: 0 },
      });

      await openAllContactsPage();
      fireEvent.click(await screen.findByRole("button", { name: "Add contact" }));

      fireEvent.change(await screen.findByLabelText("Given name"), {
        target: { value: "Grace" },
      });
      fireEvent.change(screen.getByLabelText("Family name"), {
        target: { value: "Hopper" },
      });
      const sourceSelect = screen.getByLabelText<HTMLSelectElement>("Source");
      fireEvent.change(sourceSelect, { target: { value: "family_records" } });

      fireEvent.click(screen.getByRole("button", { name: "Save contact" }));

      await waitFor(() => {
        const createCalls = calls.filter((c) => c.path === "/v1/people/create");
        expect(createCalls.length).toBe(1);
        const body = createCalls[0]?.body as Record<string, unknown>;
        expect(body.givenName).toBe("Grace");
        expect(body.familyName).toBe("Hopper");
        expect(body.source).toBe("family_records");
      });
    });

    it("All Contacts: the summary asks for the browser's month start with its offset", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const offsetSpy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-600);
      vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0));

      try {
        const { calls } = mockParityApi({
          access: { canView: true, canManage: true },
          listResult: { items: [], nextCursor: null },
          summaryResult: { total: 0, active: 0, inactive: 0, addedSince: 0 },
        });

        await openAllContactsPage();

        await waitFor(() => {
          const summaryCalls = calls.filter((c) => c.path === "/v1/people/summary");
          expect(summaryCalls.length).toBe(1);
          const body = summaryCalls[0]?.body as Record<string, unknown>;
          expect(body.addedSince).toBe("2026-07-01T00:00:00+10:00");
        });
      } finally {
        offsetSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("All Contacts: a summary failure after a group is picked clears the group filter", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      let summaryCount = 0;
      const { calls } = mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: () => {
          summaryCount++;
          if (summaryCount === 1) {
            return new Response(
              JSON.stringify({
                total: 1,
                active: 1,
                inactive: 0,
                addedSince: 1,
                groups: [{ id: "00000000-0000-4000-8000-000000000010", name: "Youth" }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(null, { status: 500 });
        },
        statusResult: { version: 2, status: "inactive" },
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      const groupSelect = await screen.findByLabelText("Group");
      fireEvent.change(groupSelect, { target: { value: "00000000-0000-4000-8000-000000000010" } });

      await waitFor(() => {
        const listCalls = calls.filter((c) => c.path === "/v1/people/list");
        const lastCall = listCalls[listCalls.length - 1];
        expect((lastCall?.body as Record<string, unknown>).groupId).toBe(
          "00000000-0000-4000-8000-000000000010",
        );
      });

      // Toggle switch to trigger summary refetch which will fail with 500
      const switchEl = screen.getByRole("switch", { name: /Ada Lovelace/ });
      fireEvent.click(switchEl);

      await screen.findByText("Counts unavailable");
      expect(screen.queryByLabelText("Group")).toBeNull();

      await waitFor(() => {
        const listCalls = calls.filter((c) => c.path === "/v1/people/list");
        const lastCall = listCalls[listCalls.length - 1];
        expect((lastCall?.body as Record<string, unknown>).groupId).toBeUndefined();
      });
    });

    it("All Contacts: an inactive contact's switch is off and labelled Inactive", async () => {
      const inactivePerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        email: "ada@example.test",
        phone: "+61 400 555 001",
        age: 42,
        createdAt: "2026-01-05T00:00:00Z",
        status: "inactive",
        source: "manual",
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [inactivePerson], nextCursor: null },
        summaryResult: { total: 1, active: 0, inactive: 1, addedSince: 1 },
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      const switchEl = screen.getByRole("switch", { name: /Ada Lovelace/ }) as HTMLInputElement;
      expect(switchEl.checked).toBe(false);
      const labelText = switchEl.closest("label")?.textContent;
      expect(labelText).toContain("Inactive");
      expect(labelText).not.toContain("Active");
    });

    it("source filter change resets the cursor (W2)", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      const { calls } = mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: "next-cursor-1" },
        summaryResult: { total: 10, active: 8, inactive: 2, addedSince: 3 },
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      // Navigate to page 2 so cursor is set
      fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
      await waitFor(() => {
        const lastCall = calls.filter((c) => c.path === "/v1/people/list").slice(-1)[0];
        expect((lastCall?.body as Record<string, unknown>).cursor).toBe("next-cursor-1");
      });

      // Change source filter
      const sourceSelect = screen.getByLabelText("Source");
      fireEvent.change(sourceSelect, { target: { value: "website" } });

      await waitFor(() => {
        const lastCall = calls.filter((c) => c.path === "/v1/people/list").slice(-1)[0];
        const body = lastCall?.body as Record<string, unknown>;
        expect(body.source).toBe("website");
        expect(body.cursor).toBeUndefined();
      });
    });

    it("group filter change resets the cursor (W3)", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      const { calls } = mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: "next-cursor-1" },
        summaryResult: {
          total: 10,
          active: 8,
          inactive: 2,
          addedSince: 3,
          groups: [{ id: "00000000-0000-4000-8000-000000000010", name: "Youth" }],
        },
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      // Navigate to page 2 so cursor is set
      fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
      await waitFor(() => {
        const lastCall = calls.filter((c) => c.path === "/v1/people/list").slice(-1)[0];
        expect((lastCall?.body as Record<string, unknown>).cursor).toBe("next-cursor-1");
      });

      // Change group filter
      const groupSelect = screen.getByLabelText("Group");
      fireEvent.change(groupSelect, { target: { value: "00000000-0000-4000-8000-000000000010" } });

      await waitFor(() => {
        const lastCall = calls.filter((c) => c.path === "/v1/people/list").slice(-1)[0];
        const body = lastCall?.body as Record<string, unknown>;
        expect(body.groupId).toBe("00000000-0000-4000-8000-000000000010");
        expect(body.cursor).toBeUndefined();
      });
    });

    it("switching to the Minors tab makes no summary call and renders no adult columns (W5)", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      const minorPerson = childRow(1);
      const { calls } = mockParityApi({
        access: { canView: true, canManage: true, canReadMinors: true },
        listResult: (body: unknown) => {
          const b = body as Record<string, unknown>;
          if (b.kind === "minors") {
            return new Response(JSON.stringify({ items: [minorPerson], nextCursor: null }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ items: [adultPerson], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      const summaryCallsBefore = calls.filter((c) => c.path === "/v1/people/summary").length;
      expect(summaryCallsBefore).toBe(1);

      const minorsTab = await screen.findByRole("button", { name: "Minors" });
      fireEvent.click(minorsTab);

      await waitFor(() => {
        expect(screen.getByText("Child 1")).toBeTruthy();
      });

      const summaryCallsAfter = calls.filter((c) => c.path === "/v1/people/summary").length;
      expect(summaryCallsAfter).toBe(summaryCallsBefore);

      const table = screen.getByRole("table", { name: "Children" });
      expect(within(table).queryByRole("columnheader", { name: "Email" })).toBeNull();
      expect(within(table).queryByRole("columnheader", { name: "Phone" })).toBeNull();
      expect(within(table).queryByRole("columnheader", { name: "Date" })).toBeNull();
      expect(within(table).queryByRole("columnheader", { name: "Groups" })).toBeNull();
      expect(within(table).queryByRole("columnheader", { name: "Source" })).toBeNull();
      expect(within(table).queryByRole("columnheader", { name: "Status" })).toBeNull();
    });

    it("renders row with email, phone, date, source label and multiple group chips without wrapping phone or date (W6, W7, W8, W9, W24, B2)", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        email: "ada@example.test",
        phone: "+61 400 555 001",
        age: 42,
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "website",
        groups: [
          { id: "00000000-0000-4000-8000-000000000010", name: "Choir" },
          { id: "00000000-0000-4000-8000-000000000020", name: "Youth" },
        ],
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: {
          total: 1,
          active: 1,
          inactive: 0,
          addedSince: 1,
          groups: [
            { id: "00000000-0000-4000-8000-000000000010", name: "Choir" },
            { id: "00000000-0000-4000-8000-000000000020", name: "Youth" },
          ],
        },
      });

      await openAllContactsPage();
      const table = await screen.findByRole("table", { name: "Contacts" });

      expect(within(table).getByText("ada@example.test")).toBeTruthy();

      const phoneEl = within(table).getByText("+61 400 555 001");
      expect(phoneEl).toBeTruthy();
      expect(phoneEl.className).toContain("whitespace-nowrap");

      const dateEl = within(table).getByText("5 Jan 2026");
      expect(dateEl).toBeTruthy();
      expect(dateEl.className).toContain("whitespace-nowrap");

      expect(within(table).getByText("Website")).toBeTruthy();
      expect(within(table).getByText("Choir")).toBeTruthy();
      expect(within(table).getByText("Youth")).toBeTruthy();
    });

    it("an inactive row's badge reads Inactive when caller lacks manage or billing is read-only (W10)", async () => {
      const inactivePerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "inactive",
        source: "manual",
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: false },
        billingStatus: { state: "ok", canView: true, canManage: false },
        listResult: { items: [inactivePerson], nextCursor: null },
        summaryResult: { total: 1, active: 0, inactive: 1, addedSince: 1 },
      });

      await openAllContactsPage();
      const table = await screen.findByRole("table", { name: "Contacts" });

      const badge = within(table).getByText("Inactive");
      expect(badge).toBeTruthy();
      expect(badge.getAttribute("data-slot")).toBe("status-badge");
      expect(within(table).queryByText("Active")).toBeNull();
    });

    it("a successful toggle updates the row, version, and the summary counts (W14, W19)", async () => {
      const activePerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      let summaryCount = 0;
      const { calls } = mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [activePerson], nextCursor: null },
        summaryResult: () => {
          summaryCount++;
          if (summaryCount === 1) {
            return new Response(
              JSON.stringify({ total: 1, active: 1, inactive: 0, addedSince: 1 }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(JSON.stringify({ total: 1, active: 0, inactive: 1, addedSince: 1 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
        statusResult: { version: 2, status: "inactive" },
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      const switchEl = screen.getByRole("switch", { name: /Ada Lovelace/ }) as HTMLInputElement;
      expect(switchEl.checked).toBe(true);

      fireEvent.click(switchEl);

      await waitFor(() => {
        expect(switchEl.checked).toBe(false);
      });

      // Row status and version updated for second click
      fireEvent.click(switchEl);
      await waitFor(() => {
        const statusCalls = calls.filter((c) => c.path === "/v1/people/status");
        expect(statusCalls.length).toBe(2);
        const secondBody = statusCalls[1]?.body as Record<string, unknown>;
        expect(secondBody.version).toBe(2);
        expect(secondBody.status).toBe("active");
      });

      // Summary counts updated: Active is 0, Inactive is 1
      await waitFor(() => {
        const cards = screen.getByText("Total contacts").closest("div.grid") as HTMLElement;
        const activeCard = within(cards).getByText("Active").parentElement;
        const inactiveCard = within(cards).getByText("Inactive").parentElement;
        expect(within(activeCard!).getByText("0")).toBeTruthy();
        expect(within(inactiveCard!).getByText("1")).toBeTruthy();
      });
    });

    it("the add form sends source 'manual' when picked or default (W15)", async () => {
      const { calls } = mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [], nextCursor: null },
        summaryResult: { total: 0, active: 0, inactive: 0, addedSince: 0 },
      });

      await openAllContactsPage();
      fireEvent.click(await screen.findByRole("button", { name: "Add contact" }));

      fireEvent.change(await screen.findByLabelText("Given name"), {
        target: { value: "Ada" },
      });
      fireEvent.change(screen.getByLabelText("Family name"), {
        target: { value: "Lovelace" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save contact" }));

      await waitFor(() => {
        const createCalls = calls.filter((c) => c.path === "/v1/people/create");
        expect(createCalls.length).toBe(1);
        const body = createCalls[0]?.body as Record<string, unknown>;
        expect(body.source).toBe("manual");
      });
    });

    it("filter with no match shows 'No contacts match these filters' for group and source filters (W18)", async () => {
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [], nextCursor: null },
        summaryResult: {
          total: 10,
          active: 8,
          inactive: 2,
          addedSince: 3,
          groups: [{ id: "00000000-0000-4000-8000-000000000010", name: "Youth" }],
        },
      });

      await openAllContactsPage();

      const sourceSelect = (await screen.findByLabelText("Source")) as HTMLSelectElement;
      fireEvent.change(sourceSelect, { target: { value: "website" } });
      expect(await screen.findByText("No contacts match these filters")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
      expect(sourceSelect.value).toBe("");

      const groupSelect = (await screen.findByLabelText("Group")) as HTMLSelectElement;
      fireEvent.change(groupSelect, { target: { value: "00000000-0000-4000-8000-000000000010" } });
      expect(await screen.findByText("No contacts match these filters")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
      expect(groupSelect.value).toBe("");
    });

    it("a second click on the switch while saving sends nothing (W23, L2)", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      let releaseStatus: (res: Response) => void = () => {};
      const { calls } = mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
        statusResult: () =>
          new Promise<Response>((resolve) => {
            releaseStatus = resolve;
          }),
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      const switchEl = screen.getByRole("switch", { name: /Ada Lovelace/ }) as HTMLInputElement;

      fireEvent.click(switchEl);
      fireEvent.click(switchEl);

      await act(async () => {
        releaseStatus(
          new Response(JSON.stringify({ version: 2, status: "inactive" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      });

      await waitFor(() => {
        const statusCalls = calls.filter((c) => c.path === "/v1/people/status");
        expect(statusCalls.length).toBe(1);
      });
    });

    it("Add contact stays available when a filter matches nothing, for a caller who may add (B3)", async () => {
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [], nextCursor: null },
        summaryResult: { total: 10, active: 8, inactive: 2, addedSince: 3 },
      });

      await openAllContactsPage();
      const statusSelect = (await screen.findByLabelText("Status")) as HTMLSelectElement;
      fireEvent.change(statusSelect, { target: { value: "inactive" } });

      await screen.findByText("No contacts match these filters");
      const addBtn = screen.getByRole("button", { name: "Add contact" });
      expect(addBtn).toBeTruthy();
    });

    it("a 402 on the switch is handled by setting payment-required and refreshing billing (L1)", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      const { calls } = mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
        statusResult: 402,
      });

      await openAllContactsPage();
      await screen.findByRole("table", { name: "Contacts" });

      const billingCallsBefore = calls.filter((c) => c.path === "/v1/billing/status").length;
      const switchEl = screen.getByRole("switch", { name: /Ada Lovelace/ });
      fireEvent.click(switchEl);

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Unable to update contact status");

      await waitFor(() => {
        const billingCallsAfter = calls.filter((c) => c.path === "/v1/billing/status").length;
        expect(billingCallsAfter).toBeGreaterThan(billingCallsBefore);
      });
      expect(await screen.findByText("Read-only until billing is settled")).toBeTruthy();
    });

    it("an item without source does not default to manual and sends no source on edit (L3)", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        version: 1,
      };
      const { calls } = mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
        readResult: {
          personId: adultPerson.id,
          isMinor: false,
          givenName: "Ada",
          familyName: "Lovelace",
          version: 1,
          status: "active",
        },
        updateResult: { version: 2 },
      });

      await openAllContactsPage();
      fireEvent.click(await screen.findByRole("button", { name: "View Ada Lovelace" }));
      fireEvent.click(await screen.findByRole("button", { name: "Edit contact" }));

      const sourceSelect = await screen.findByLabelText<HTMLSelectElement>("Source");
      expect(sourceSelect.value).toBe("keep");
      expect(sourceSelect.options[0]?.textContent).toBe("Keep current (None)");

      fireEvent.change(screen.getByLabelText("Given name"), { target: { value: "Adalyn" } });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => {
        const updateCalls = calls.filter((c) => c.path === "/v1/people/update");
        expect(updateCalls.length).toBe(1);
        const updateBody = updateCalls[0]?.body as Record<string, unknown>;
        expect(updateBody.source).toBeUndefined();
      });
    });

    it("an isMinor: true item on the adults tab is not shown (L4)", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      const minorPerson = {
        id: "00000000-0000-4000-8000-000000000002",
        personId: "00000000-0000-4000-8000-000000000002",
        isMinor: true,
        givenName: "Secret",
        familyName: "Minor",
        createdAt: "2026-01-05T00:00:00Z",
        status: "active",
        source: "manual",
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: true },
        listResult: { items: [adultPerson, minorPerson], nextCursor: null },
        summaryResult: { total: 1, active: 1, inactive: 0, addedSince: 1 },
      });

      await openAllContactsPage();
      const table = await screen.findByRole("table", { name: "Contacts" });

      expect(within(table).getByText("Ada")).toBeTruthy();
      expect(within(table).queryByText("Secret")).toBeNull();
    });

    it("runs axe on add form, edit form, empty-filter state, badge state and counts unavailable", async () => {
      const adultPerson = {
        id: "00000000-0000-4000-8000-000000000001",
        personId: "00000000-0000-4000-8000-000000000001",
        isMinor: false,
        givenName: "Ada",
        familyName: "Lovelace",
        email: "ada@example.test",
        phone: "+61 400 555 001",
        age: 42,
        createdAt: "2026-01-05T00:00:00Z",
        status: "inactive",
        source: "manual",
        version: 1,
      };
      mockParityApi({
        access: { canView: true, canManage: false },
        listResult: { items: [adultPerson], nextCursor: null },
        summaryResult: 500,
      });

      const container = await openAllContactsPage();
      await screen.findByText("Counts unavailable");

      const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
      expect(resultIds(results, "violations")).toEqual([]);
    });

    it("every source key has a label", () => {
      const expectedKeys = [
        "manual",
        "family_records",
        "website",
        "form",
        "donation",
        "event_rsvp",
        "event_booking",
        "volunteer_application",
        "mobile_app",
        "mobile_app_family",
        "auto",
      ];
      expect(PERSON_SOURCES).toEqual(expectedKeys);
      for (const key of expectedKeys) {
        expect(PERSON_SOURCE_LABELS[key]).toBeTruthy();
        expect(typeof PERSON_SOURCE_LABELS[key]).toBe("string");
      }
    });
  });
});

describe("Contact delete on All Contacts (Task 9)", () => {
  const ADA_ID = "00000000-0000-4000-8000-0000000000a1";
  const GRACE_ID = "00000000-0000-4000-8000-0000000000a2";
  const ADA = {
    id: ADA_ID,
    givenName: "Ada",
    familyName: "Lovelace",
    email: "ada@example.test",
    phone: "+61 400 555 001",
    age: 42,
    createdAt: "2026-01-05T00:00:00Z",
    status: "active",
    source: "manual",
    version: 3,
  };
  const GRACE = { ...ADA, id: GRACE_ID, givenName: "Grace", familyName: "Hopper", version: 5 };
  const DELETED_ADA = {
    id: ADA_ID,
    givenName: "Ada",
    familyName: "Lovelace",
    deletedAt: "2026-11-10T02:00:00Z",
    purgeAfter: "2026-12-10T02:00:00Z",
    version: 4,
  };

  const MSG_CHANGED = "This contact was changed. Reload and try again.";
  const MSG_PURGED = "This contact was deleted permanently.";
  const MSG_DUPLICATE = "A deleted contact has this email (or phone).";
  const MSG_DUPLICATE_RESTORE = `${MSG_DUPLICATE} Restore it from the Deleted filter.`;

  type CallBody = Record<string, unknown>;
  type Call = { path: string; url: string; body: CallBody | undefined };
  type Handler = (body: CallBody) => Response | Promise<Response>;
  type Options = {
    canDelete?: boolean;
    canManage?: boolean;
    billing?: "ok" | "read_only" | "loading";
    list?: Handler;
    summary?: Handler;
    del?: Handler;
    restore?: Handler;
    create?: Handler;
    update?: Handler;
    read?: Handler;
  };

  function jsonResponse(status: number, value: unknown): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function emptyResponse(status: number): Response {
    return new Response(null, { status });
  }

  function longDate(iso: string): string {
    return new Intl.DateTimeFormat("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(iso));
  }

  function defaultList(body: CallBody): Response {
    if (body.status === "deleted") {
      return jsonResponse(200, { items: [DELETED_ADA], nextCursor: null });
    }
    return jsonResponse(200, { items: [ADA, GRACE], nextCursor: null });
  }

  function mockDeleteApi(options: Options = {}) {
    const calls: Call[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      let body: CallBody | undefined;
      if (init?.body) {
        const parsed: unknown = JSON.parse(String(init.body));
        body = typeof parsed === "object" && parsed !== null ? { ...parsed } : undefined;
      }
      calls.push({ path, url, body });
      const input = body ?? {};

      if (path === "/v1/access/capabilities") {
        return jsonResponse(200, {
          permissions: {
            "people.view": true,
            "people.manage": options.canManage ?? true,
            "people.restricted.read": false,
            "people.delete": options.canDelete ?? true,
          },
          entitlements: { "people.directory": true, "people.households": true },
        });
      }
      if (path === "/v1/billing/status") {
        if (options.billing === "loading") {
          return new Promise<Response>(() => {});
        }
        return jsonResponse(200, {
          state: options.billing ?? "ok",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        });
      }
      if (path === "/v1/people/list") {
        return (options.list ?? defaultList)(input);
      }
      if (path === "/v1/people/summary") {
        return options.summary
          ? options.summary(input)
          : jsonResponse(200, { total: 2, active: 2, inactive: 0, addedSince: 1 });
      }
      if (path === "/v1/people/delete") {
        return options.del
          ? options.del(input)
          : jsonResponse(200, {
              personId: input.personId,
              version: 4,
              purgeAfter: "2026-12-23T12:00:00Z",
            });
      }
      if (path === "/v1/people/restore") {
        return options.restore
          ? options.restore(input)
          : jsonResponse(200, { personId: input.personId, version: 5 });
      }
      if (path === "/v1/people/create") {
        return options.create ? options.create(input) : jsonResponse(201, { personId: ADA_ID });
      }
      if (path === "/v1/people/update") {
        return options.update ? options.update(input) : jsonResponse(200, { version: 4 });
      }
      if (path === "/v1/people/read") {
        return options.read
          ? options.read(input)
          : jsonResponse(200, {
              personId: ADA_ID,
              isMinor: false,
              givenName: "Ada",
              familyName: "Lovelace",
              email: "ada@example.test",
              phone: "+61 400 555 001",
              dateOfBirth: "1980-01-01",
              version: 3,
              status: "active",
              source: "manual",
            });
      }
      return emptyResponse(404);
    });
    return calls;
  }

  function callsTo(calls: Call[], path: string): Call[] {
    return calls.filter((call) => call.path === path);
  }

  async function openScreen(options: Options = {}) {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const calls = mockDeleteApi(options);
    const container = await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    await screen.findByRole("table", { name: "Contacts" });
    return { calls, container };
  }

  async function resetScreen() {
    cleanup();
    sessionStorage.clear();
    vi.restoreAllMocks();
    await router.navigate("/");
  }

  async function showDeleted() {
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
      target: { value: "deleted" },
    });
    await screen.findByText(/^Deleted .*, deleted permanently on /);
  }

  async function openDeleteDialog(name: string) {
    const trigger = await screen.findByRole("button", { name: `Delete ${name}` });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    return { trigger, dialog };
  }

  function confirmButton(dialog: HTMLElement): HTMLElement {
    return within(dialog).getByRole("button", { name: "Delete contact" });
  }

  it("no Delete action without people.delete", async () => {
    await openScreen({ canDelete: false });
    expect(screen.getAllByRole("button", { name: /^View / })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
    await resetScreen();

    await openScreen({ canDelete: true });
    expect(screen.getByRole("button", { name: "Delete Ada Lovelace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete Grace Hopper" })).toBeTruthy();
  });

  it("no Deleted filter without people.delete", async () => {
    await openScreen({ canDelete: false });
    const status = screen.getByRole("combobox", { name: "Status" });
    expect(within(status).queryByRole("option", { name: "Deleted" })).toBeNull();
    await resetScreen();

    await openScreen({ canDelete: true });
    const withDelete = screen.getByRole("combobox", { name: "Status" });
    expect(within(withDelete).getByRole("option", { name: "Deleted" })).toBeTruthy();
  });

  it("Delete and Restore are hidden when billing is read-only", async () => {
    for (const billing of ["read_only", "loading"] as const) {
      await openScreen({ billing });
      if (billing === "read_only") {
        await screen.findByText(/Read-only until billing is settled/i);
      }
      expect(screen.getByRole("button", { name: /^View Ada/ })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();

      const status = screen.getByRole("combobox", { name: "Status" });
      expect(within(status).getByRole("option", { name: "Deleted" })).toBeTruthy();
      await showDeleted();
      const table = screen.getByRole("table", { name: "Contacts" });
      expect(within(table).getByText("Ada")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Restore/ })).toBeNull();
      await resetScreen();
    }

    const { calls } = await openScreen({ billing: "ok" });
    expect(screen.getByRole("button", { name: "Delete Ada Lovelace" })).toBeTruthy();
    await showDeleted();
    expect(screen.getByRole("button", { name: "Restore Ada Lovelace" })).toBeTruthy();
    expect(callsTo(calls, "/v1/people/delete")).toHaveLength(0);
  });

  it("a 402 to delete or restore shows the read-only banner and hides the controls", async () => {
    const first = await openScreen({ del: () => emptyResponse(402) });
    const billingBefore = callsTo(first.calls, "/v1/billing/status").length;
    const { dialog } = await openDeleteDialog("Ada Lovelace");
    fireEvent.click(confirmButton(dialog));
    await screen.findByText(/Read-only until billing is settled/i);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Unable to delete contact")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
    await waitFor(() =>
      expect(callsTo(first.calls, "/v1/billing/status").length).toBeGreaterThan(billingBefore),
    );
    await resetScreen();

    const second = await openScreen({ restore: () => emptyResponse(402) });
    await showDeleted();
    fireEvent.click(screen.getByRole("button", { name: "Restore Ada Lovelace" }));
    await screen.findByText(/Read-only until billing is settled/i);
    expect(screen.getByText("Unable to restore contact")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Restore/ })).toBeNull();
    expect(callsTo(second.calls, "/v1/people/restore")).toHaveLength(1);
  });

  it("opens a confirm dialog with the spec text and sends the id and version in the body", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T12:00:00Z"));
    const { calls } = await openScreen();
    const { dialog } = await openDeleteDialog("Ada Lovelace");

    expect(within(dialog).getByText("Delete Ada Lovelace?")).toBeTruthy();
    const purgeDate = longDate("2026-12-23T12:00:00Z");
    expect(
      within(dialog).getByText(
        `They are hidden now and deleted permanently on ${purgeDate}. Staff with the delete permission can restore them until then.`,
      ),
    ).toBeTruthy();
    expect(callsTo(calls, "/v1/people/delete")).toHaveLength(0);

    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(callsTo(calls, "/v1/people/delete")).toHaveLength(1));
    const sent = callsTo(calls, "/v1/people/delete")[0];
    expect(sent?.body).toEqual({ communitySlug: SLUG, personId: ADA_ID, version: 3 });
    expect(sent?.url.endsWith("/v1/people/delete")).toBe(true);
    expect(sent?.url).not.toContain(ADA_ID);
    expect(sent?.url).not.toContain("?");
  });

  it("a successful delete closes the dialog, reloads the list and counts, and moves focus to the heading", async () => {
    let deleted = false;
    const { calls } = await openScreen({
      del: (body) => {
        deleted = true;
        return jsonResponse(200, {
          personId: body.personId,
          version: 4,
          purgeAfter: "2026-12-23T12:00:00Z",
        });
      },
      list: (body) =>
        body.status === "deleted"
          ? jsonResponse(200, { items: [], nextCursor: null })
          : jsonResponse(200, { items: deleted ? [GRACE] : [ADA, GRACE], nextCursor: null }),
    });
    const listBefore = callsTo(calls, "/v1/people/list").length;
    const summaryBefore = callsTo(calls, "/v1/people/summary").length;
    const { dialog } = await openDeleteDialog("Ada Lovelace");
    fireEvent.click(confirmButton(dialog));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.queryByText("Ada")).toBeNull());
    expect(screen.getByText("Grace")).toBeTruthy();
    expect(callsTo(calls, "/v1/people/list")).toHaveLength(listBefore + 1);
    expect(callsTo(calls, "/v1/people/summary")).toHaveLength(summaryBefore + 1);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "All Contacts" })),
    );
  });

  it("a second click on Delete while the request is pending sends nothing more", async () => {
    let release: (response: Response) => void = () => {};
    const { calls } = await openScreen({
      del: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    const { dialog } = await openDeleteDialog("Ada Lovelace");
    const confirm = confirmButton(dialog);
    fireEvent.click(confirm);
    await waitFor(() => expect(callsTo(calls, "/v1/people/delete")).toHaveLength(1));
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(callsTo(calls, "/v1/people/delete")).toHaveLength(1);
    expect(confirm.getAttribute("aria-busy")).toBe("true");

    release(
      jsonResponse(200, { personId: ADA_ID, version: 4, purgeAfter: "2026-12-23T12:00:00Z" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(callsTo(calls, "/v1/people/delete")).toHaveLength(1);
  });

  it("Cancel and Escape never delete and return focus to the row's Delete button", async () => {
    const { calls } = await openScreen();

    const first = await openDeleteDialog("Ada Lovelace");
    fireEvent.click(within(first.dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(first.trigger));

    const second = await openDeleteDialog("Grace Hopper");
    fireEvent.keyDown(second.dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(second.trigger));

    expect(callsTo(calls, "/v1/people/delete")).toHaveLength(0);
  });

  it("the dialog shows the message for each refusal code", async () => {
    const cases: { response: () => Response; message: string }[] = [
      {
        response: () => jsonResponse(409, { code: "linked_user" }),
        message: "This contact is linked to a user account. Remove the user first.",
      },
      {
        response: () => jsonResponse(409, { code: "pending_invitation" }),
        message: "This contact has a pending invitation. Cancel it first.",
      },
      {
        response: () => jsonResponse(409, { code: "sole_guardian" }),
        message:
          "This contact is the only guardian of a child. Add another guardian in Family Records first.",
      },
      { response: () => emptyResponse(409), message: MSG_CHANGED },
    ];
    let next = 0;
    const { calls } = await openScreen({
      del: () => {
        const current = cases[next];
        next += 1;
        return current ? current.response() : emptyResponse(500);
      },
    });
    const listBefore = callsTo(calls, "/v1/people/list").length;

    for (const [index, { message }] of cases.entries()) {
      const { dialog } = await openDeleteDialog("Ada Lovelace");
      expect(within(dialog).queryByRole("alert")).toBeNull();
      fireEvent.click(confirmButton(dialog));
      await waitFor(() => expect(callsTo(calls, "/v1/people/delete")).toHaveLength(index + 1));
      expect(await within(dialog).findByText(message)).toBeTruthy();
      expect(screen.getByRole("dialog")).toBe(dialog);
      const table = screen.getByRole("table", { name: "Contacts", hidden: true });
      expect(within(table).getByText("Ada")).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    expect(callsTo(calls, "/v1/people/list")).toHaveLength(listBefore);
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("a delete answered 500 says so in the dialog and keeps it open", async () => {
    const { calls } = await openScreen({ del: () => emptyResponse(500) });
    const { dialog } = await openDeleteDialog("Ada Lovelace");
    fireEvent.click(confirmButton(dialog));
    expect(await within(dialog).findByText("Unable to delete contact")).toBeTruthy();
    expect(callsTo(calls, "/v1/people/delete")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("the Deleted list is its own request and never sends source, group or a cursor from the other list", async () => {
    const { calls } = await openScreen({
      list: (body) => {
        if (body.status === "deleted") {
          return jsonResponse(200, { items: [DELETED_ADA], nextCursor: "deleted-next" });
        }
        return jsonResponse(200, { items: [ADA], nextCursor: "adult-next" });
      },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), {
      target: { value: "website" },
    });
    await waitFor(() =>
      expect(
        callsTo(calls, "/v1/people/list").some((call) => call.body?.source === "website"),
      ).toBe(true),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(callsTo(calls, "/v1/people/list").some((c) => c.body?.cursor === "adult-next")).toBe(
        true,
      ),
    );

    const before = callsTo(calls, "/v1/people/list").length;
    await showDeleted();
    const deletedCalls = callsTo(calls, "/v1/people/list").slice(before);
    expect(deletedCalls).toHaveLength(1);
    expect(deletedCalls[0]?.body).toEqual({
      communitySlug: SLUG,
      kind: "adults",
      status: "deleted",
    });
    expect(screen.queryByRole("combobox", { name: "Source" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(callsTo(calls, "/v1/people/list").at(-1)?.body).toEqual({
        communitySlug: SLUG,
        kind: "adults",
        status: "deleted",
        cursor: "deleted-next",
      }),
    );

    const beforeBack = callsTo(calls, "/v1/people/list").length;
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "" } });
    await waitFor(() =>
      expect(callsTo(calls, "/v1/people/list").length).toBeGreaterThan(beforeBack),
    );
    const back = callsTo(calls, "/v1/people/list").slice(beforeBack);
    expect(back).toHaveLength(1);
    expect(back[0]?.body).toEqual({ communitySlug: SLUG, kind: "adults" });
  });

  it("Deleted rows show the name, both dates and Restore, and no switch, View, email or phone", async () => {
    await openScreen();
    await showDeleted();
    const table = screen.getByRole("table", { name: "Contacts" });

    expect(within(table).getByText("Ada")).toBeTruthy();
    expect(within(table).getByText("Lovelace")).toBeTruthy();
    expect(
      within(table).getByText(
        `Deleted ${longDate("2026-11-10T02:00:00Z")}, deleted permanently on ${longDate("2026-12-10T02:00:00Z")}`,
      ),
    ).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Restore Ada Lovelace" })).toBeTruthy();
    expect(within(table).queryByRole("switch")).toBeNull();
    expect(within(table).queryByRole("button", { name: /^View/ })).toBeNull();
    expect(within(table).queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(within(table).queryByRole("columnheader", { name: "Email" })).toBeNull();
    expect(within(table).queryByRole("columnheader", { name: "Phone" })).toBeNull();
    expect(screen.queryByText("ada@example.test")).toBeNull();
    expect(screen.queryByText("Total contacts")).toBeNull();
  });

  it("the Deleted filter shows 'No deleted contacts.' when the list is empty", async () => {
    await openScreen({
      list: (body) =>
        body.status === "deleted"
          ? jsonResponse(200, { items: [], nextCursor: null })
          : jsonResponse(200, { items: [ADA], nextCursor: null }),
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
      target: { value: "deleted" },
    });
    expect(await screen.findByText("No deleted contacts.")).toBeTruthy();
    expect(screen.queryByText("No contacts yet")).toBeNull();
    expect(screen.queryByText("No contacts match these filters")).toBeNull();
  });

  it("the Deleted list searches by name only", async () => {
    const { calls } = await openScreen();
    await showDeleted();
    const box = screen.getByRole("textbox", { name: "Search contacts" });
    fireEvent.change(box, { target: { value: "Ada" } });
    fireEvent.submit(box);
    await waitFor(() =>
      expect(callsTo(calls, "/v1/people/list").at(-1)?.body).toEqual({
        communitySlug: SLUG,
        kind: "adults",
        status: "deleted",
        search: "Ada",
      }),
    );
  });

  it("Restore sends the id and version in the body, once, then reloads the list and counts", async () => {
    let release: (response: Response) => void = () => {};
    let restored = false;
    const { calls } = await openScreen({
      restore: () =>
        new Promise<Response>((resolve) => {
          release = (response) => {
            restored = true;
            resolve(response);
          };
        }),
      list: (body) =>
        body.status === "deleted"
          ? jsonResponse(200, { items: restored ? [] : [DELETED_ADA], nextCursor: null })
          : jsonResponse(200, { items: [ADA], nextCursor: null }),
    });
    await showDeleted();
    const listBefore = callsTo(calls, "/v1/people/list").length;
    const summaryBefore = callsTo(calls, "/v1/people/summary").length;
    const restore = screen.getByRole("button", { name: "Restore Ada Lovelace" });
    fireEvent.click(restore);
    await waitFor(() => expect(callsTo(calls, "/v1/people/restore")).toHaveLength(1));
    fireEvent.click(restore);
    fireEvent.click(restore);
    expect(callsTo(calls, "/v1/people/restore")).toHaveLength(1);
    const sent = callsTo(calls, "/v1/people/restore")[0];
    expect(sent?.body).toEqual({ communitySlug: SLUG, personId: ADA_ID, version: 4 });
    expect(sent?.url.endsWith("/v1/people/restore")).toBe(true);
    expect(sent?.url).not.toContain(ADA_ID);

    release(jsonResponse(200, { personId: ADA_ID, version: 5 }));
    expect(await screen.findByText("No deleted contacts.")).toBeTruthy();
    expect(callsTo(calls, "/v1/people/restore")).toHaveLength(1);
    expect(callsTo(calls, "/v1/people/list")).toHaveLength(listBefore + 1);
    expect(callsTo(calls, "/v1/people/summary")).toHaveLength(summaryBefore + 1);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "All Contacts" })),
    );
  });

  it("restore of a purged contact says so and reloads", async () => {
    let purged = false;
    const { calls } = await openScreen({
      restore: () => {
        purged = true;
        return emptyResponse(404);
      },
      list: (body) =>
        body.status === "deleted"
          ? jsonResponse(200, { items: purged ? [] : [DELETED_ADA], nextCursor: null })
          : jsonResponse(200, { items: [ADA], nextCursor: null }),
    });
    await showDeleted();
    const listBefore = callsTo(calls, "/v1/people/list").length;
    fireEvent.click(screen.getByRole("button", { name: "Restore Ada Lovelace" }));

    expect(await screen.findByText(MSG_PURGED)).toBeTruthy();
    await waitFor(() => expect(callsTo(calls, "/v1/people/list")).toHaveLength(listBefore + 1));
    expect(await screen.findByText("No deleted contacts.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Restore/ })).toBeNull();
  });

  it("a delete answered 404 for a purged contact says so, closes the dialog and reloads", async () => {
    const { calls } = await openScreen({ del: () => emptyResponse(404) });
    const listBefore = callsTo(calls, "/v1/people/list").length;
    const { dialog } = await openDeleteDialog("Ada Lovelace");
    fireEvent.click(confirmButton(dialog));

    expect(await screen.findByText(MSG_PURGED)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(callsTo(calls, "/v1/people/list")).toHaveLength(listBefore + 1));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "All Contacts" })),
    );
  });

  it("a delete answered 404 also refreshes the counts", async () => {
    const { calls } = await openScreen({ del: () => emptyResponse(404) });
    const listBefore = callsTo(calls, "/v1/people/list").length;
    const summaryBefore = callsTo(calls, "/v1/people/summary").length;
    const { dialog } = await openDeleteDialog("Ada Lovelace");
    fireEvent.click(confirmButton(dialog));

    expect(await screen.findByText(MSG_PURGED)).toBeTruthy();
    await waitFor(() => expect(callsTo(calls, "/v1/people/list")).toHaveLength(listBefore + 1));
    await waitFor(() =>
      expect(callsTo(calls, "/v1/people/summary")).toHaveLength(summaryBefore + 1),
    );
    await flushPending();
    expect(callsTo(calls, "/v1/people/list")).toHaveLength(listBefore + 1);
    expect(callsTo(calls, "/v1/people/summary")).toHaveLength(summaryBefore + 1);
  });

  it("a restore answered 409 asks for a reload and keeps the row", async () => {
    const { calls } = await openScreen({ restore: () => emptyResponse(409) });
    await showDeleted();
    fireEvent.click(screen.getByRole("button", { name: "Restore Ada Lovelace" }));
    expect(await screen.findByText(MSG_CHANGED)).toBeTruthy();
    expect(callsTo(calls, "/v1/people/restore")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Restore Ada Lovelace" })).toBeTruthy();
  });

  // A delete or restore answer that arrives after the community changed belongs to the old
  // community. The new one shows no alert and no dialog and makes no further list or counts
  // request. Each answer is released by the test after the change, never by a timer.
  const OTHER_SLUG = "other-parish";
  const LATE_ANSWERS: { name: string; answer: () => Response }[] = [
    {
      name: "200",
      answer: () =>
        jsonResponse(200, { personId: ADA_ID, version: 4, purgeAfter: "2026-12-23T12:00:00Z" }),
    },
    { name: "404", answer: () => emptyResponse(404) },
    { name: "409", answer: () => jsonResponse(409, { code: "sole_guardian" }) },
  ];

  async function flushPending() {
    for (let turn = 0; turn < 3; turn += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function switchCommunity(calls: Call[]) {
    // An open Delete dialog is modal and hides the picker from the accessibility tree, so the
    // picker is found with hidden: true.
    fireEvent.change(screen.getByRole("textbox", { name: "Community", hidden: true }), {
      target: { value: OTHER_SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set", hidden: true }));
    await screen.findByRole("table", { name: "Contacts" });
    const inOther = (path: string) =>
      callsTo(calls, path).filter((call) => call.body?.communitySlug === OTHER_SLUG).length;
    await waitFor(() => {
      expect(inOther("/v1/people/list")).toBeGreaterThan(0);
      expect(inOther("/v1/people/summary")).toBeGreaterThan(0);
    });
    await flushPending();
    return {
      list: callsTo(calls, "/v1/people/list").length,
      summary: callsTo(calls, "/v1/people/summary").length,
    };
  }

  function expectQuiet(calls: Call[], before: { list: number; summary: number }) {
    expect(callsTo(calls, "/v1/people/list")).toHaveLength(before.list);
    expect(callsTo(calls, "/v1/people/summary")).toHaveLength(before.summary);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(MSG_PURGED)).toBeNull();
    expect(screen.queryByText(MSG_CHANGED)).toBeNull();
  }

  it("a delete answer that arrives after the community changed is ignored", async () => {
    for (const late of LATE_ANSWERS) {
      let release: (response: Response) => void = () => {};
      const { calls } = await openScreen({
        del: () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      });
      const { dialog } = await openDeleteDialog("Ada Lovelace");
      fireEvent.click(confirmButton(dialog));
      await waitFor(() => expect(callsTo(calls, "/v1/people/delete")).toHaveLength(1));

      const before = await switchCommunity(calls);
      expect(screen.queryByRole("dialog")).toBeNull();

      await act(async () => {
        release(late.answer());
      });
      await flushPending();
      expectQuiet(calls, before);
      expect(callsTo(calls, "/v1/people/delete")).toHaveLength(1);
      await resetScreen();
    }
  });

  it("a delete refusal read after the community changed is ignored", async () => {
    // The 409 head arrives before the change; its body is read after it. The refusal would
    // otherwise land in a Delete dialog the user opened in the new community.
    let releaseBody: () => void = () => {};
    const { calls } = await openScreen({
      del: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              releaseBody = () => {
                controller.enqueue(
                  new TextEncoder().encode(JSON.stringify({ code: "sole_guardian" })),
                );
                controller.close();
              };
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    });
    const first = await openDeleteDialog("Ada Lovelace");
    fireEvent.click(confirmButton(first.dialog));
    await waitFor(() => expect(callsTo(calls, "/v1/people/delete")).toHaveLength(1));
    await flushPending();

    const before = await switchCommunity(calls);
    const second = await openDeleteDialog("Grace Hopper");
    expect(within(second.dialog).queryByRole("alert")).toBeNull();

    await act(async () => {
      releaseBody();
    });
    await flushPending();
    expect(within(second.dialog).queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("dialog")).toBe(second.dialog);
    expect(callsTo(calls, "/v1/people/list")).toHaveLength(before.list);
    expect(callsTo(calls, "/v1/people/summary")).toHaveLength(before.summary);
    expect(callsTo(calls, "/v1/people/delete")).toHaveLength(1);
  });

  it("a restore answer that arrives after the community changed is ignored", async () => {
    for (const late of LATE_ANSWERS) {
      let release: (response: Response) => void = () => {};
      const { calls } = await openScreen({
        restore: () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      });
      await showDeleted();
      fireEvent.click(screen.getByRole("button", { name: "Restore Ada Lovelace" }));
      await waitFor(() => expect(callsTo(calls, "/v1/people/restore")).toHaveLength(1));

      const before = await switchCommunity(calls);

      await act(async () => {
        release(
          late.name === "200" ? jsonResponse(200, { personId: ADA_ID, version: 5 }) : late.answer(),
        );
      });
      await flushPending();
      expectQuiet(calls, before);
      expect(callsTo(calls, "/v1/people/restore")).toHaveLength(1);
      await resetScreen();
    }
  });

  it("the deleted-duplicate message offers restore only to people.delete holders", async () => {
    for (const canDelete of [true, false]) {
      const expected = canDelete ? MSG_DUPLICATE_RESTORE : MSG_DUPLICATE;
      await openScreen({
        canDelete,
        create: () => jsonResponse(409, { code: "duplicate_deleted" }),
        update: () => jsonResponse(409, { code: "duplicate_deleted" }),
      });

      fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
      fireEvent.change(await screen.findByLabelText("Given name"), { target: { value: "Ada" } });
      fireEvent.change(screen.getByLabelText("Family name"), { target: { value: "Lovelace" } });
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.test" } });
      fireEvent.click(screen.getByRole("button", { name: "Save contact" }));
      const createAlert = await screen.findByRole("alert");
      expect(createAlert.textContent).toBe(expected);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      fireEvent.click(await screen.findByRole("button", { name: "View Ada Lovelace" }));
      fireEvent.click(await screen.findByRole("button", { name: "Edit contact" }));
      fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
      const editAlert = await screen.findByRole("alert");
      expect(editAlert.textContent).toBe(expected);
      await resetScreen();
    }
  });

  it("an older 409 with an empty body keeps today's messages on create and edit", async () => {
    await openScreen({
      create: () => emptyResponse(409),
      update: () => emptyResponse(409),
    });
    fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
    fireEvent.change(await screen.findByLabelText("Given name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Family name"), { target: { value: "Lovelace" } });
    fireEvent.click(screen.getByRole("button", { name: "Save contact" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Unable to save contact");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(await screen.findByRole("button", { name: "View Ada Lovelace" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit contact" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "This contact was changed by someone else, or that email or phone is already in use.",
    );
  });

  it("a deep link to a hidden contact answers as for an unknown contact", async () => {
    await openScreen({ read: () => emptyResponse(404) });
    fireEvent.click(await screen.findByRole("button", { name: "View Ada Lovelace" }));
    expect(await screen.findByText("Contact not found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit contact" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Restore/ })).toBeNull();
  });

  it("has no axe violations in the Delete dialog, in light and dark, and in the Deleted list", async () => {
    const { container } = await openScreen({
      del: () => jsonResponse(409, { code: "sole_guardian" }),
    });
    const { dialog } = await openDeleteDialog("Ada Lovelace");
    fireEvent.click(confirmButton(dialog));
    await within(dialog).findByText(/only guardian of a child/);
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.dataset.theme = theme;
      const results = await axe.run(document.body, {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(resultIds(results, "violations"), theme).toEqual([]);
    }
    delete document.documentElement.dataset.theme;
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await showDeleted();
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.dataset.theme = theme;
      const results = await axe.run(container, {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(resultIds(results, "violations"), theme).toEqual([]);
    }
    delete document.documentElement.dataset.theme;
  });
});
