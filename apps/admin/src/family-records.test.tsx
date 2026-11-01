import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function mockApi({
  access = {},
  listResult = { items: [], nextCursor: null },
  detailResult,
}: {
  access?: CapabilitiesInput;
  listResult?: { items: unknown[]; nextCursor: string | null } | number;
  detailResult?: unknown | number;
} = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
    const url = String(info);
    const path = url.replace(/^https?:\/\/[^/]+/, "");

    if (path === "/v1/access/capabilities") {
      return mockCapabilitiesResponse(access);
    }

    if (path === "/v1/households/list") {
      if (typeof listResult === "number") {
        return new Response(null, { status: listResult });
      }
      return new Response(JSON.stringify(listResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (path === "/v1/households/read") {
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
    mockApi({ access: { householdsEnabled: false, canView: true, canReadMinors: true } });

    const container = await showFamilyRecords();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText("Not allowed")).toBeTruthy();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("shows Not allowed and makes no list call when caller lacks people.view", async () => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    let listCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/v1/access/capabilities") {
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

    expect(await screen.findByText("Not allowed")).toBeTruthy();
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

  it("renders — for household label when label is null (unrestricted caller or unlabelled)", async () => {
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
    expect(screen.getByText("Clarke Family")).toBeTruthy();
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
    expect(screen.getByText("Arthur")).toBeTruthy();

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
    expect(screen.getByText("Arthur")).toBeTruthy();

    // Pin 21: UI MUST NOT render minors section without people.restricted.read
    expect(screen.queryByRole("heading", { name: "Minors" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Guardians" })).toBeNull();
    expect(screen.queryByText("Leo")).toBeNull();
  });
});
