import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

function mockApi(
  access:
    | {
        directoryEnabled: boolean;
        canView: boolean;
        canManage: boolean;
        canReadMinors: boolean;
      }
    | number = { directoryEnabled: true, canView: true, canManage: true, canReadMinors: true },
  listResult: { items: unknown[]; nextCursor: string | null } | number = {
    items: [],
    nextCursor: null,
  },
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
    const url = String(info);
    const path = url.replace(/^https?:\/\/[^/]+/, "");

    if (path === "/v1/people/access") {
      if (typeof access === "number") {
        return new Response(null, { status: access });
      }
      return new Response(JSON.stringify(access), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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

  it("hides Contacts & Members when access route returns 403 or unavailable", async () => {
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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: false,
            canManage: true,
            canReadMinors: false,
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

    expect(await screen.findByText("Not allowed")).toBeTruthy();
    const listCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith("/v1/people/list"),
    );
    expect(listCalls).toHaveLength(0);
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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");

      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: true,
            canReadMinors: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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

    await screen.findByRole("heading", { name: "All Contacts" });
    const searchInput = screen.getByRole("textbox", { name: "Search contacts" });
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
  });

  it("handles keyset pagination when nextCursor is returned", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let requestedCursor: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: true,
            canReadMinors: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
    expect(screen.queryByRole("tab", { name: "Minors" })).toBeNull();
    expect(screen.queryByText("Minors")).toBeNull();
  });

  it("renders Minors tab and fetches minors when canReadMinors is true", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let capturedKind: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: true,
            canReadMinors: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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

    await showContacts();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const minorsTab = await screen.findByRole("tab", { name: "Minors" });
    fireEvent.click(minorsTab);

    expect(await screen.findByText("Child")).toBeTruthy();
    expect(capturedKind).toBe("minors");
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
    const searchInput = screen.getByRole("textbox", { name: "Search contacts" });
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
      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: true,
            canReadMinors: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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

    expect(await screen.findByText("Failed to load contacts")).toBeTruthy();
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

      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: true,
            canReadMinors: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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

    const minorsTab = screen.getByRole("tab", { name: "Minors" });
    fireEvent.click(minorsTab);

    // Minors tab must NOT render the search box
    expect(screen.queryByRole("textbox", { name: "Search contacts" })).toBeNull();

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

      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: true,
            canReadMinors: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
    const minorsTab = screen.getByRole("tab", { name: "Minors" });
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

  it("shows contact details from /v1/people/read including version and passes axe", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: true,
            canReadMinors: false,
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
    const viewButton = screen.getByRole("button", { name: "View" });
    fireEvent.click(viewButton);

    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    expect(screen.getByText("ada@example.test")).toBeTruthy();
    expect(screen.getByText("+61400000001")).toBeTruthy();
    expect(screen.getByText("1980-05-12")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("hides Edit button in detail view when caller lacks people.manage (Pin 15)", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: false,
            canReadMinors: false,
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

    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit contact" })).toBeNull();
  });

  it("creates an adult contact via POST /v1/people/create and passes axe", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    const createdId = "00000000-0000-4000-8000-000000000099";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: true,
            canReadMinors: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: true,
            canReadMinors: false,
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
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    const editButton = screen.getByRole("button", { name: "Edit contact" });
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
      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: true,
            canReadMinors: false,
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
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit contact" }));

    expect(await screen.findByRole("heading", { name: "Edit Contact" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(/A conflict occurred while saving|That change conflicted/i),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("email");
    expect(document.body.textContent).not.toContain("phone");
    expect(document.body.textContent).not.toContain("email_bidx_conflict");

    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("shows plain not-found on 404 in detail view", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: true,
            canReadMinors: false,
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
    fireEvent.click(screen.getByRole("button", { name: "View" }));

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
      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: true,
            canReadMinors: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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

    const minorsTab = await screen.findByRole("tab", { name: "Minors" });
    fireEvent.click(minorsTab);

    expect(await screen.findByText("Child")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View" }));

    expect(await screen.findByRole("heading", { name: "Contact Details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit contact" })).toBeNull();
  });

  it("guards Add form against double-submission while in flight", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let createResolve: ((val: Response) => void) | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: true,
            canReadMinors: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
      if (path === "/v1/people/access") {
        return new Response(
          JSON.stringify({
            directoryEnabled: true,
            canView: true,
            canManage: true,
            canReadMinors: false,
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
    fireEvent.click(screen.getByRole("button", { name: "View" }));

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
});
