import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { StrictMode } from "react";
import { afterEach, beforeEach } from "vitest";

import { router, Shell } from "./shell";

const EMAIL = "ada@example.com";
const USER = "00000000-0000-4000-8000-000000000002";
const TOKEN = "token-1";

function resultIds(
  results: axe.AxeResults,
  bucket: "passes" | "violations" | "incomplete" | "inapplicable",
): string[] {
  return results[bucket].map((entry) => entry.id);
}

function directory(customRoleCount: number, grants: unknown[], permissions: string[] = []) {
  return {
    grants,
    customRoles: Array.from({ length: customRoleCount }, (_, index) => ({
      customRoleId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      key: `role_${index}`,
      permissions: ["access.users.view"],
    })),
    catalogue: ["access.users.view", "access.roles.manage"],
    builtIn: [
      {
        roleKey: "org_owner",
        scope: "organisation",
        permissions: ["access.users.view", "access.roles.manage"],
      },
    ],
    userLinks: [],
    permissions,
  };
}

const ownerGrant = {
  grantId: "00000000-0000-4000-8000-000000000020",
  scope: "organisation",
  userId: USER,
  roleKey: "org_owner",
  customRoleId: null,
  customRoleKey: null,
  email: EMAIL,
  givenName: "Ada Person",
  phone: "+61400000000",
};

const defaultUserDetail = {
  userId: USER,
  personId: "00000000-0000-4000-8000-000000000099",
  name: { given: "Morgan", family: "Finch" },
  email: "morgan.finch@example.com",
  phone: "+61491570006",
  minor: false,
};

function usersListResponse(users: unknown[] = [defaultUserDetail], phoneVisible = true) {
  return {
    phoneVisible,
    users,
  };
}

function urlKeyedFetch(handlers: {
  grants?: (slug: string, init?: RequestInit) => Response | Promise<Response>;
  users?: (slug: string, init?: RequestInit) => Response | Promise<Response>;
  other?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const bodyStr = typeof init?.body === "string" ? init.body : "{}";
    let slug = "";
    try {
      const parsed = JSON.parse(bodyStr);
      if (typeof parsed?.communitySlug === "string") {
        slug = parsed.communitySlug;
      }
    } catch {
      // ignore
    }

    if (url.includes("/v1/access/grants/list")) {
      if (handlers.grants) {
        return handlers.grants(slug, init);
      }
      return new Response(JSON.stringify(directory(0, [ownerGrant], ["access.users.view"])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes("/v1/access/users/list")) {
      if (handlers.users) {
        return handlers.users(slug, init);
      }
      return new Response(JSON.stringify(usersListResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (handlers.other) {
      return handlers.other(url, init);
    }

    return new Response(null, { status: 404 });
  });
}

async function showUsers(): Promise<HTMLElement> {
  await router.navigate("/settings/users");
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

it("asks for sign-in and does not fetch without a token", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("fetch called");
  });
  await showUsers();
  expect(screen.getByRole("heading", { name: "Users & Roles" })).toBeTruthy();
  expect(screen.getByText("Sign in required")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in");
  expect(screen.getByRole("navigation", { name: "Admin" })).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("renders names, emails, phones, secondary user ids and role labels when users/list succeeds", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  const fetchSpy = urlKeyedFetch({
    grants: () =>
      new Response(JSON.stringify(directory(0, [ownerGrant], ["access.users.view"])), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    users: () =>
      new Response(
        JSON.stringify(
          usersListResponse([
            {
              userId: USER,
              personId: "00000000-0000-4000-8000-000000000099",
              name: { given: "Morgan", family: "Finch" },
              email: "morgan.finch@example.com",
              phone: "+61491570006",
              minor: false,
            },
          ]),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  const container = await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Morgan Finch")).toBeTruthy();
  expect(screen.getByText("morgan.finch@example.com")).toBeTruthy();
  expect(screen.getByText("+61491570006")).toBeTruthy();
  expect(screen.getByText(USER, { exact: false })).toBeTruthy();
  expect(screen.getByText("Organisation Owner")).toBeTruthy();

  const usersCall = fetchSpy.mock.calls.find((call) =>
    String(call[0]).includes("/v1/access/users/list"),
  );
  expect(usersCall).toBeDefined();
  expect(String(usersCall?.[0])).toBe("https://au.api.example.test/v1/access/users/list");
  expect(String(usersCall?.[0])).not.toContain("parish");
  expect(String(usersCall?.[0])).not.toContain(TOKEN);
  const init = usersCall?.[1] as RequestInit;
  expect(init.method).toBe("POST");
  expect(init.body).toBe(JSON.stringify({ communitySlug: "parish" }));
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);

  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(resultIds(results, "violations")).toEqual([]);
});

it("renders 'Details hidden' and no personal data anywhere on screen for minor: true, even if body carried details", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    users: () =>
      new Response(
        JSON.stringify(
          usersListResponse([
            {
              userId: USER,
              personId: "00000000-0000-4000-8000-000000000099",
              name: { given: "Robin", family: "Taylor" },
              email: "robin.taylor@example.com",
              phone: "+61491570156",
              minor: true,
            },
          ]),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Details hidden")).toBeTruthy();
  expect(screen.getByText(USER, { exact: false })).toBeTruthy();
  expect(screen.getByText("Organisation Owner")).toBeTruthy();

  expect(document.body.textContent).not.toContain("Robin");
  expect(document.body.textContent).not.toContain("Taylor");
  expect(document.body.textContent).not.toContain("robin.taylor@example.com");
  expect(document.body.textContent).not.toContain("+61491570156");
});

it("renders 'No contact linked' in the name slot when personId is null and not minor", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    users: () =>
      new Response(
        JSON.stringify(
          usersListResponse([
            {
              userId: USER,
              personId: null,
              name: null,
              email: "morgan.finch@example.com",
              phone: "+61491570006",
              minor: false,
            },
          ]),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("No contact linked")).toBeTruthy();
  expect(screen.getByText("morgan.finch@example.com")).toBeTruthy();
  expect(screen.getByText("+61491570006")).toBeTruthy();
  expect(screen.getByText(USER, { exact: false })).toBeTruthy();
});

it("renders 'No sign-in account' in the email slot when email is null and minor: false", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    users: () =>
      new Response(
        JSON.stringify(
          usersListResponse([
            {
              userId: USER,
              personId: "00000000-0000-4000-8000-000000000099",
              name: { given: "Morgan", family: "Finch" },
              email: null,
              phone: "+61491570006",
              minor: false,
            },
          ]),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("No sign-in account")).toBeTruthy();
  expect(screen.getByText("Morgan Finch")).toBeTruthy();
  expect(screen.getByText("+61491570006")).toBeTruthy();
});

it("renders '—' in the phone slot when phone is missing and phoneVisible is true", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    users: () =>
      new Response(
        JSON.stringify(
          usersListResponse(
            [
              {
                userId: USER,
                personId: "00000000-0000-4000-8000-000000000099",
                name: { given: "Morgan", family: "Finch" },
                email: "morgan.finch@example.com",
                phone: null,
                minor: false,
              },
            ],
            true,
          ),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Morgan Finch")).toBeTruthy();
  expect(screen.getByText("morgan.finch@example.com")).toBeTruthy();
  expect(screen.getByText("—")).toBeTruthy();
});

it("renders nothing in the phone slot when phoneVisible is false", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    users: () =>
      new Response(
        JSON.stringify(
          usersListResponse(
            [
              {
                userId: USER,
                personId: "00000000-0000-4000-8000-000000000099",
                name: { given: "Morgan", family: "Finch" },
                email: "morgan.finch@example.com",
                phone: "+61491570006",
                minor: false,
              },
            ],
            false,
          ),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Morgan Finch")).toBeTruthy();
  expect(screen.getByText("morgan.finch@example.com")).toBeTruthy();
  expect(document.body.textContent).not.toContain("+61491570006");
  expect(screen.queryByText("—")).toBeNull();
});

it("keeps ids view when users state has no row for that user", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    users: () =>
      new Response(JSON.stringify(usersListResponse([])), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();
  expect(screen.getAllByText("Organisation Owner", { exact: false }).length).toBeGreaterThan(0);
  expect(document.body.textContent).not.toContain("Morgan Finch");
});

it("shows 'Too many users to show details' and keeps ids view on 409", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    users: () => new Response(null, { status: 409 }),
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Too many users to show details")).toBeTruthy();
  expect(screen.getByText(USER, { exact: false })).toBeTruthy();
  expect(screen.getAllByText("Organisation Owner", { exact: false }).length).toBeGreaterThan(0);
});

it("shows 'Details unavailable. Try again.' and keeps ids view on 500", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    users: () => new Response(null, { status: 500 }),
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Details unavailable. Try again.")).toBeTruthy();
  expect(screen.getByText(USER, { exact: false })).toBeTruthy();
  expect(screen.getAllByText("Organisation Owner", { exact: false }).length).toBeGreaterThan(0);
});

it("shows 'Details unavailable. Try again.' on network unavailability", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    users: () => Promise.reject(new TypeError("Failed to fetch")),
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Details unavailable. Try again.")).toBeTruthy();
  expect(screen.getByText(USER, { exact: false })).toBeTruthy();
});

it("shows 'Details unavailable. Try again.' on rejected json()", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    users: () =>
      new Response("{ invalid-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Details unavailable. Try again.")).toBeTruthy();
});

it("shows 'Details unavailable. Try again.' on malformed response body", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    users: () =>
      new Response(JSON.stringify({ notUsers: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Details unavailable. Try again.")).toBeTruthy();
  expect(screen.getByText(USER, { exact: false })).toBeTruthy();
});

it("shows 'Details unavailable. Try again.' on non-200 with JSON body (502)", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    users: () =>
      new Response(JSON.stringify({ error: "bad_gateway" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Details unavailable. Try again.")).toBeTruthy();
  expect(screen.getByText(USER, { exact: false })).toBeTruthy();
});

it("shows no message and does not show page notice on users/list 403", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    users: () => new Response(null, { status: 403 }),
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();
  expect(screen.queryByText("You cannot manage roles")).toBeNull();
  expect(screen.queryByText(/Details unavailable/i)).toBeNull();
  expect(screen.queryByText(/Too many users/i)).toBeNull();
});

it("shows 'Sign in required' when users/list returns 401", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    users: () => new Response(null, { status: 401 }),
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Sign in required")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
});

it("does not call users/list when caller lacks access.users.view (exact call count 0)", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let usersCallCount = 0;
  urlKeyedFetch({
    grants: () =>
      new Response(
        JSON.stringify(directory(0, [ownerGrant], ["access.roles.view", "access.roles.manage"])),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    users: () => {
      usersCallCount++;
      return new Response(JSON.stringify(usersListResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();
  expect(usersCallCount).toBe(0);
});

it("calls users/list again after a grant change through the form", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let usersCalls = 0;
  urlKeyedFetch({
    grants: () =>
      new Response(
        JSON.stringify(directory(0, [ownerGrant], ["access.users.view", "access.roles.manage"])),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    users: () => {
      usersCalls++;
      return new Response(JSON.stringify(usersListResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    other: (url) => {
      if (url.includes("/v1/access/grants/revoke")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    },
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Morgan Finch")).toBeTruthy();
  expect(usersCalls).toBe(1);

  const revokeButton = screen.getByRole("button", { name: "Revoke" });
  fireEvent.click(revokeButton);

  await screen.findByText("Morgan Finch");
  expect(usersCalls).toBe(2);
});

it("regression: calls users/list exactly once for the new community when switching while grants/list is pending", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let resolveParishGrants!: (value: Response) => void;
  const parishGrantsPromise = new Promise<Response>((resolve) => {
    resolveParishGrants = resolve;
  });

  const usersListCalledSlugs: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String((init as RequestInit).body));
    if (url.includes("/v1/access/grants/list")) {
      if (body.communitySlug === "parish") {
        return parishGrantsPromise;
      }
      if (body.communitySlug === "cathedral") {
        return new Response(JSON.stringify(directory(0, [ownerGrant], ["access.users.view"])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    if (url.includes("/v1/access/users/list")) {
      usersListCalledSlugs.push(body.communitySlug);
      return new Response(JSON.stringify(usersListResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 404 });
  });

  await showUsers();

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Morgan Finch")).toBeTruthy();

  resolveParishGrants(
    new Response(JSON.stringify(directory(0, [ownerGrant], ["access.users.view"])), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  await act(async () => {
    await parishGrantsPromise;
  });

  expect(usersListCalledSlugs).toEqual(["cathedral"]);
});

it("renders under StrictMode without duplicate or inconsistent display", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({});
  await router.navigate("/settings/users");
  render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Morgan Finch")).toBeTruthy();
  expect(screen.getByText("Organisation Owner")).toBeTruthy();
});

it("Pin 17(a): stale response after await post never calls json()", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let resolveParishUsers!: (value: Response) => void;
  const parishUsersPromise = new Promise<Response>((resolve) => {
    resolveParishUsers = resolve;
  });

  let onParishUsersCalled!: () => void;
  const parishUsersCalledPromise = new Promise<void>((resolve) => {
    onParishUsersCalled = resolve;
  });

  const staleResponse = new Response(
    JSON.stringify(
      usersListResponse([
        {
          userId: USER,
          personId: "00000000-0000-4000-8000-000000000099",
          name: { given: "Alice", family: "One" },
          email: "alice1@example.com",
          phone: "+61491570006",
          minor: false,
        },
      ]),
    ),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  const jsonSpy = vi.spyOn(staleResponse, "json");

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String((init as RequestInit).body));
    if (url.includes("/v1/access/grants/list")) {
      return new Response(JSON.stringify(directory(0, [ownerGrant], ["access.users.view"])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/v1/access/users/list")) {
      if (body.communitySlug === "parish") {
        onParishUsersCalled();
        return parishUsersPromise;
      }
      if (body.communitySlug === "cathedral") {
        return new Response(
          JSON.stringify(
            usersListResponse([
              {
                userId: USER,
                personId: "00000000-0000-4000-8000-000000000099",
                name: { given: "Bob", family: "Two" },
                email: "bob2@example.com",
                phone: "+61491570156",
                minor: false,
              },
            ]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
    }
    return new Response(null, { status: 404 });
  });

  await showUsers();

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  // Wait until parish's users/list has actually been called
  await parishUsersCalledPromise;

  // Switch to cathedral while parish users/list is pending
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Bob Two")).toBeTruthy();

  // Now resolve the stale parish response
  resolveParishUsers(staleResponse);
  await act(async () => {
    await parishUsersPromise;
  });

  expect(jsonSpy).not.toHaveBeenCalled();
});

it("Pin 17(b): stale response after json() never renders community 1 details", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let resolveParishJson!: (value: unknown) => void;
  const parishJsonPromise = new Promise((resolve) => {
    resolveParishJson = resolve;
  });

  let onParishJsonCalled!: () => void;
  const parishJsonCalledPromise = new Promise<void>((resolve) => {
    onParishJsonCalled = resolve;
  });

  const staleResponse = {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => {
      onParishJsonCalled();
      return parishJsonPromise;
    },
  } as unknown as Response;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String((init as RequestInit).body));
    if (url.includes("/v1/access/grants/list")) {
      return new Response(JSON.stringify(directory(0, [ownerGrant], ["access.users.view"])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/v1/access/users/list")) {
      if (body.communitySlug === "parish") {
        return staleResponse;
      }
      if (body.communitySlug === "cathedral") {
        return new Response(
          JSON.stringify(
            usersListResponse([
              {
                userId: USER,
                personId: "00000000-0000-4000-8000-000000000099",
                name: { given: "Bob", family: "Two" },
                email: "bob2@example.com",
                phone: "+61491570156",
                minor: false,
              },
            ]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
    }
    return new Response(null, { status: 404 });
  });

  await showUsers();

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  // Wait until parish's json() is called and pending
  await parishJsonCalledPromise;

  // Switch to cathedral while parish json() is pending
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Bob Two")).toBeTruthy();

  // Resolve stale json()
  resolveParishJson(
    usersListResponse([
      {
        userId: USER,
        personId: "00000000-0000-4000-8000-000000000099",
        name: { given: "Alice", family: "One" },
        email: "alice1@example.com",
        phone: "+61491570006",
        minor: false,
      },
    ]),
  );

  await act(async () => {
    await parishJsonPromise;
  });

  expect(screen.getByText("Bob Two")).toBeTruthy();
  expect(document.body.textContent).not.toContain("Alice One");
  expect(document.body.textContent).not.toContain("alice1@example.com");
  expect(document.body.textContent).not.toContain("+61491570006");
});

it("Pin 17(c): stale response whose json() rejects leaves no 'Details unavailable' message", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let rejectParishJson!: (reason: unknown) => void;
  const parishJsonPromise = new Promise((_, reject) => {
    rejectParishJson = reject;
  });

  let onParishJsonCalled!: () => void;
  const parishJsonCalledPromise = new Promise<void>((resolve) => {
    onParishJsonCalled = resolve;
  });

  const staleResponse = {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => {
      onParishJsonCalled();
      return parishJsonPromise;
    },
  } as unknown as Response;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String((init as RequestInit).body));
    if (url.includes("/v1/access/grants/list")) {
      return new Response(JSON.stringify(directory(0, [ownerGrant], ["access.users.view"])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/v1/access/users/list")) {
      if (body.communitySlug === "parish") {
        return staleResponse;
      }
      if (body.communitySlug === "cathedral") {
        return new Response(
          JSON.stringify(
            usersListResponse([
              {
                userId: USER,
                personId: "00000000-0000-4000-8000-000000000099",
                name: { given: "Bob", family: "Two" },
                email: "bob2@example.com",
                phone: "+61491570156",
                minor: false,
              },
            ]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
    }
    return new Response(null, { status: 404 });
  });

  await showUsers();

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  // Wait until parish's json() is called and pending
  await parishJsonCalledPromise;

  // Switch to cathedral while parish json() is pending
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Bob Two")).toBeTruthy();

  // Reject stale json()
  rejectParishJson(new Error("rejected json"));

  await act(async () => {
    try {
      await parishJsonPromise;
    } catch {
      // expected
    }
  });

  expect(screen.queryByText(/Details unavailable/i)).toBeNull();
  expect(screen.getByText("Bob Two")).toBeTruthy();
});

it("Pin 19: clears users state on community change while new users/list is pending", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  const pendingPromise = new Promise<Response>(() => {});

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String((init as RequestInit).body));
    if (url.includes("/v1/access/grants/list")) {
      return new Response(JSON.stringify(directory(0, [ownerGrant], ["access.users.view"])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/v1/access/users/list")) {
      if (body.communitySlug === "parish") {
        return new Response(
          JSON.stringify(
            usersListResponse([
              {
                userId: USER,
                personId: "00000000-0000-4000-8000-000000000099",
                name: { given: "Alice", family: "One" },
                email: "alice1@example.com",
                phone: "+61491570006",
                minor: false,
              },
            ]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (body.communitySlug === "cathedral") {
        return pendingPromise; // Held pending, never resolves
      }
    }
    return new Response(null, { status: 404 });
  });

  await showUsers();

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Alice One")).toBeTruthy();
  expect(screen.getByText("alice1@example.com")).toBeTruthy();
  expect(screen.getByText("+61491570006")).toBeTruthy();

  // Switch to cathedral: grants/list will resolve, but users/list is held pending
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  // Cathedral's grants list is loaded: row shows USER in ids view
  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();

  // While users/list is pending, community 2's row for USER shows NO community-1 name, email or phone
  expect(document.body.textContent).not.toContain("Alice One");
  expect(document.body.textContent).not.toContain("alice1@example.com");
  expect(document.body.textContent).not.toContain("+61491570006");
});

it("hides custom role creation at the limit of 20", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(directory(20, [ownerGrant])), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
  expect(await screen.findByText("Custom role limit reached")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create custom role" })).toBeNull();
  expect(document.body.textContent).not.toContain(EMAIL);
});

it("shows no grants without a bootstrap control", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(directory(0, [])), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
  expect(await screen.findByText("No role grants")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Become the owner" })).toBeNull();
});

it("hides Grant, Revoke, and Delete without access.roles.manage", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    grants: () =>
      new Response(
        JSON.stringify(directory(1, [ownerGrant], ["access.users.view", "access.users.manage"])),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete custom role" })).toBeNull();
  expect(screen.getByRole("button", { name: "Link" })).toBeTruthy();
});

it("hides the create custom role form without access.roles.manage", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    grants: () =>
      new Response(
        JSON.stringify(directory(1, [ownerGrant], ["access.users.view", "access.users.manage"])),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create custom role" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Custom role key" })).toBeNull();
  expect(screen.getByRole("button", { name: "Link" })).toBeTruthy();
});

it("hides Link without access.users.manage", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify(directory(1, [ownerGrant], ["access.roles.view", "access.roles.manage"])),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
  expect(await screen.findByRole("button", { name: "Grant" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete custom role" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
});

it("shows the role errors for 403 and 409", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 403 }));
  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
  expect(await screen.findByText("You cannot manage roles")).toBeTruthy();

  cleanup();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 409 }));
  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
  expect(await screen.findByText("That change was rejected")).toBeTruthy();
});

it("loads from the context slug with no slug field of its own", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  sessionStorage.setItem("community-hub.community", "parish");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(directory(0, [ownerGrant])), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await showUsers();
  expect(within(screen.getByRole("main")).queryByRole("textbox", { name: "Community" })).toBeNull();
  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();
});

it("clears rows and write controls when switching to a community that answers 403", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    if (body.communitySlug === "parish") {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            directory(1, [ownerGrant], ["access.roles.manage", "access.users.manage"]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 403 }));
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Grant" })).toBeTruthy();

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("You cannot manage roles")).toBeTruthy();
  expect(screen.queryByText(USER, { exact: false })).toBeNull();
  expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create custom role" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
});

it("ignores a stale response that arrives after the slug has changed", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let resolveCathedral!: (value: Response) => void;
  const cathedralPromise = new Promise<Response>((resolve) => {
    resolveCathedral = resolve;
  });

  vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    if (body.communitySlug === "cathedral") {
      return cathedralPromise;
    }
    if (body.communitySlug === "abbey") {
      return Promise.resolve(
        new Response(JSON.stringify(directory(0, [], ["access.roles.manage"])), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });

  await showUsers();

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "abbey" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("No role grants")).toBeTruthy();

  resolveCathedral(
    new Response(JSON.stringify(directory(0, [ownerGrant], ["access.roles.manage"])), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  await act(async () => {
    await cathedralPromise;
  });

  expect(screen.getByText("No role grants")).toBeTruthy();
  expect(screen.queryByText(USER, { exact: false })).toBeNull();
});

it("retries fetching when Set is pressed again with the same slug", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let attempts = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    if (String(input).includes("/v1/access/grants/list")) {
      attempts++;
      if (attempts === 1) {
        return Promise.resolve(new Response(null, { status: 403 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(directory(0, [ownerGrant], ["access.roles.manage"])), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 200 }));
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("You cannot manage roles")).toBeTruthy();
  expect(attempts).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();
  expect(attempts).toBe(2);
});

it("ignores a write that finishes after switching to a forbidden community", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let resolveRevoke!: (value: Response) => void;
  const revokePromise = new Promise<Response>((resolve) => {
    resolveRevoke = resolve;
  });

  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/access/grants/revoke")) {
      return revokePromise;
    }
    const body = JSON.parse(String((init as RequestInit).body));
    if (body.communitySlug === "parish") {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            directory(1, [ownerGrant], ["access.roles.manage", "access.users.manage"]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 403 }));
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();
  const revokeButton = screen.getByRole("button", { name: "Revoke" });

  fireEvent.click(revokeButton);

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("You cannot manage roles")).toBeTruthy();

  resolveRevoke(new Response(null, { status: 200 }));
  await act(async () => {
    await revokePromise;
  });

  expect(screen.getByText("You cannot manage roles")).toBeTruthy();
  expect(screen.queryByText(USER, { exact: false })).toBeNull();
  expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create custom role" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
});

it("ignores a write that finishes with 401 after switching to a forbidden community", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let resolveRevoke!: (value: Response) => void;
  const revokePromise = new Promise<Response>((resolve) => {
    resolveRevoke = resolve;
  });
  let parishLists = 0;

  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/access/grants/revoke")) {
      return revokePromise;
    }
    if (url.endsWith("/v1/access/grants/list")) {
      const body = JSON.parse(String((init as RequestInit).body));
      if (body.communitySlug === "parish") {
        parishLists++;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              directory(1, [ownerGrant], ["access.roles.manage", "access.users.manage"]),
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 403 }));
    }
    return Promise.resolve(new Response(null, { status: 403 }));
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();
  const revokeButton = screen.getByRole("button", { name: "Revoke" });

  fireEvent.click(revokeButton);

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("You cannot manage roles")).toBeTruthy();

  resolveRevoke(new Response(null, { status: 401 }));
  await act(async () => {
    await revokePromise;
  });

  expect(screen.getByText("You cannot manage roles")).toBeTruthy();
  expect(parishLists).toBe(1);
  expect(screen.queryByText(USER, { exact: false })).toBeNull();
  expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
});

it("ignores a follow-up reload that finishes after switching to a forbidden community", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);

  let parishListCalls = 0;
  let resolveParishReload!: (value: Response) => void;
  const parishReloadPromise = new Promise<Response>((resolve) => {
    resolveParishReload = resolve;
  });

  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/access/grants/revoke")) {
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    if (url.includes("/v1/access/grants/list")) {
      const body = JSON.parse(String((init as RequestInit).body));
      if (body.communitySlug === "parish") {
        parishListCalls++;
        if (parishListCalls === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify(
                directory(1, [ownerGrant], ["access.roles.manage", "access.users.manage"]),
              ),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return parishReloadPromise;
      }
      return Promise.resolve(new Response(null, { status: 403 }));
    }
    return Promise.resolve(new Response(null, { status: 200 }));
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();
  const revokeButton = screen.getByRole("button", { name: "Revoke" });

  fireEvent.click(revokeButton);

  await vi.waitFor(() => {
    expect(parishListCalls).toBe(2);
  });

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("You cannot manage roles")).toBeTruthy();

  resolveParishReload(
    new Response(JSON.stringify(directory(0, [ownerGrant], ["access.roles.manage"])), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  await act(async () => {
    await parishReloadPromise;
  });
  await act(async () => {});

  expect(screen.getByText("You cannot manage roles")).toBeTruthy();
  expect(screen.queryByText(USER, { exact: false })).toBeNull();
  expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create custom role" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
});

function billingStatusResponse(state: string) {
  return new Response(
    JSON.stringify({
      state,
      canView: true,
      canManage: true,
      trial_end: null,
      grace_until: null,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

it.each(["none", "read_only"])(
  "hides all write controls and shows read-only alert in %s (pin 16)",
  async (state) => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/v1/billing/status")) {
        return Promise.resolve(billingStatusResponse(state));
      }
      if (url.includes("/v1/access/grants/list")) {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              directory(1, [ownerGrant], ["access.roles.manage", "access.users.manage"]),
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const container = await showUsers();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: "parish" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    const readOnlyAlert = (
      await screen.findByText("Read-only until billing is settled")
    ).closest<HTMLElement>('[data-slot="alert"]')!;
    expect(within(readOnlyAlert).getByRole("link").getAttribute("href")).toBe("/settings/general");

    expect(screen.getByText(USER, { exact: false })).toBeTruthy();
    expect(screen.getByText("role_0", { exact: false })).toBeTruthy();

    expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create custom role" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete custom role" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unlink" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Custom role key" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "User" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Role" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Person" })).toBeNull();

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(resultIds(results, "violations")).toEqual([]);
  },
);

it.each(["grace", "retrying", "ok", "invoiced"])(
  "shows write controls and no alert in %s",
  async (state) => {
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/v1/billing/status")) {
        return Promise.resolve(billingStatusResponse(state));
      }
      if (url.includes("/v1/access/grants/list")) {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              directory(1, [ownerGrant], ["access.roles.manage", "access.users.manage"]),
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    await showUsers();
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: "parish" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByRole("button", { name: "Grant" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create custom role" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete custom role" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unlink" })).toBeTruthy();
    expect(screen.queryByText("Read-only until billing is settled")).toBeNull();
  },
);

it("keeps write controls visible and hides read-only alert when billing status is unknown or fails", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/v1/billing/status")) {
      return Promise.resolve(new Response(null, { status: 403 }));
    }
    if (url.includes("/v1/access/grants/list")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            directory(1, [ownerGrant], ["access.roles.manage", "access.users.manage"]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByRole("button", { name: "Grant" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
  expect(screen.queryByText("Read-only until billing is settled")).toBeNull();
});

it("hides Grant while status is loading after switching to a read_only community", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let resolveCathedralStatus!: (value: Response) => void;
  const cathedralStatusPromise = new Promise<Response>((resolve) => {
    resolveCathedralStatus = resolve;
  });

  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes("/v1/billing/status")) {
      const body = JSON.parse(String((init as RequestInit).body)) as { communitySlug?: string };
      if (body.communitySlug === "parish") {
        return Promise.resolve(billingStatusResponse("ok"));
      }
      if (body.communitySlug === "cathedral") {
        return cathedralStatusPromise;
      }
    }
    if (url.includes("/v1/access/grants/list")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            directory(1, [ownerGrant], ["access.roles.manage", "access.users.manage"]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByRole("button", { name: "Grant" })).toBeTruthy();

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  expect(screen.queryByText("Read-only until billing is settled")).toBeNull();

  resolveCathedralStatus(billingStatusResponse("read_only"));
  await act(async () => {
    await cathedralStatusPromise;
  });

  expect(await screen.findByText("Read-only until billing is settled")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
});

it("handles 402 on mutation by showing read-only alert, hiding write controls, and calling refresh exactly once", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let statusCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/v1/billing/status")) {
      statusCalls++;
      return Promise.resolve(billingStatusResponse("ok"));
    }
    if (url.includes("/v1/access/grants/list")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            directory(1, [ownerGrant], ["access.roles.manage", "access.users.manage"]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.includes("/v1/access/grants/revoke")) {
      return Promise.resolve(new Response(null, { status: 402 }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  const revokeButton = await screen.findByRole("button", { name: "Revoke" });
  expect(statusCalls).toBe(1);

  fireEvent.click(revokeButton);

  const readOnlyAlert = (
    await screen.findByText("Read-only until billing is settled")
  ).closest<HTMLElement>('[data-slot="alert"]')!;
  expect(within(readOnlyAlert).getByRole("link").getAttribute("href")).toBe("/settings/general");
  expect(statusCalls).toBe(2);

  expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create custom role" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete custom role" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Unlink" })).toBeNull();
});

it("ignores a 402 mutation response that arrives after switching community", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let resolveRevoke!: (value: Response) => void;
  const revokePromise = new Promise<Response>((resolve) => {
    resolveRevoke = resolve;
  });
  let statusCalls = 0;

  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/v1/billing/status")) {
      statusCalls++;
      return Promise.resolve(billingStatusResponse("ok"));
    }
    if (url.includes("/v1/access/grants/revoke")) {
      return revokePromise;
    }
    if (url.includes("/v1/access/grants/list")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            directory(1, [ownerGrant], ["access.roles.manage", "access.users.manage"]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  const revokeButton = await screen.findByRole("button", { name: "Revoke" });
  expect(statusCalls).toBe(1);

  fireEvent.click(revokeButton);

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  await screen.findByText(USER, { exact: false });
  expect(statusCalls).toBe(2);

  resolveRevoke(new Response(null, { status: 402 }));
  await act(async () => {
    await revokePromise;
  });

  expect(screen.queryByText("Read-only until billing is settled")).toBeNull();
  expect(screen.getByRole("button", { name: "Grant" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
  expect(statusCalls).toBe(2);
});

it("resets read-only blocked state when switching community after a 402 write", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let statusCalls = 0;
  let revokeCalls = 0;
  let listCalls = 0;

  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/v1/billing/status")) {
      statusCalls++;
      return Promise.resolve(billingStatusResponse("ok"));
    }
    if (url.includes("/v1/access/grants/revoke")) {
      revokeCalls++;
      return Promise.resolve(new Response(null, { status: 402 }));
    }
    if (url.includes("/v1/access/grants/list")) {
      listCalls++;
      return Promise.resolve(
        new Response(
          JSON.stringify(
            directory(1, [ownerGrant], ["access.roles.manage", "access.users.manage"]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });

  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  const revokeButton = await screen.findByRole("button", { name: "Revoke" });
  expect(screen.getByRole("button", { name: "Grant" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create custom role" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete custom role" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Link" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Unlink" })).toBeTruthy();
  expect(screen.queryByText("Read-only until billing is settled")).toBeNull();
  expect(statusCalls).toBe(1);
  expect(listCalls).toBe(1);

  fireEvent.click(revokeButton);

  const readOnlyAlert = (
    await screen.findByText("Read-only until billing is settled")
  ).closest<HTMLElement>('[data-slot="alert"]')!;
  expect(within(readOnlyAlert).getByRole("link").getAttribute("href")).toBe("/settings/general");
  expect(statusCalls).toBe(2);
  expect(revokeCalls).toBe(1);

  expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create custom role" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete custom role" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Unlink" })).toBeNull();

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByRole("button", { name: "Revoke" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Grant" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create custom role" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete custom role" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Link" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Unlink" })).toBeTruthy();
  expect(screen.queryByText("Read-only until billing is settled")).toBeNull();
  expect(statusCalls).toBe(3);
  expect(listCalls).toBe(2);
  expect(revokeCalls).toBe(1);
});

it("renders Users & Roles in StrictMode cleanly", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/v1/billing/status")) {
      return Promise.resolve(billingStatusResponse("none"));
    }
    if (url.includes("/v1/access/grants/list")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            directory(1, [ownerGrant], ["access.roles.manage", "access.users.manage"]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });

  await router.navigate("/settings/users");
  render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("Read-only until billing is settled")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
});

it("hides 'Create custom role' button when custom role limit of 20 is reached, and shows it when fewer (pin 34)", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(directory(20, [ownerGrant], ["access.roles.manage"])), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();
  expect(screen.getByText("Custom role limit reached")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create custom role" })).toBeNull();

  cleanup();
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(directory(19, [ownerGrant], ["access.roles.manage"])), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByRole("button", { name: "Create custom role" })).toBeTruthy();
  expect(screen.queryByText("Custom role limit reached")).toBeNull();
});

it("gives each list item flex flex-wrap items-center gap-2 across all four lists", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  urlKeyedFetch({
    grants: () =>
      new Response(
        JSON.stringify({
          grants: [ownerGrant],
          customRoles: [
            {
              customRoleId: "00000000-0000-4000-8000-000000000001",
              key: "custom_role",
              permissions: ["access.users.view"],
            },
          ],
          catalogue: ["access.users.view", "access.roles.manage"],
          builtIn: [
            {
              roleKey: "org_owner",
              scope: "organisation",
              permissions: ["access.users.view"],
            },
          ],
          userLinks: [
            {
              userId: USER,
              personId: "00000000-0000-4000-8000-000000000099",
            },
          ],
          permissions: ["access.users.view", "access.roles.manage"],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  });
  const container = await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findAllByText(USER, { exact: false })).toHaveLength(2);
  const listItems = container.querySelectorAll("li");
  expect(listItems.length).toBe(4);
  for (const li of listItems) {
    expect(li.className).toContain("flex");
    expect(li.className).toContain("flex-wrap");
    expect(li.className).toContain("items-center");
    expect(li.className).toContain("gap-2");
  }
});
