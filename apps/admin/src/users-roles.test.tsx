import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
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

it("loads ids and role keys and does not render personal details", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(directory(0, [ownerGrant])), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const container = await showUsers();
  expect(screen.queryByText("No role grants")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText(USER, { exact: false })).toBeTruthy();
  expect(document.body.textContent).toContain("org_owner");
  expect(document.body.textContent).toContain("access.users.view");
  expect(document.body.textContent).not.toContain(EMAIL);
  expect(document.body.textContent).not.toContain("Ada Person");
  expect(document.body.textContent).not.toContain("+61400000000");
  expect(screen.queryByRole("button", { name: "Become the owner" })).toBeNull();

  const call = fetchSpy.mock.calls[0];
  expect(String(call?.[0])).toBe("https://au.api.example.test/v1/access/grants/list");
  expect(String(call?.[0])).not.toContain("parish");
  expect(String(call?.[0])).not.toContain(TOKEN);
  const init = call?.[1] as RequestInit;
  expect(init.method).toBe("POST");
  expect(init.body).toBe(JSON.stringify({ communitySlug: "parish" }));
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);

  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(resultIds(results, "violations")).toEqual([]);
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
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify(directory(1, [ownerGrant], ["access.users.view", "access.users.manage"])),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
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
          JSON.stringify(directory(1, [ownerGrant], ["access.roles.manage", "access.users.manage"])),
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
        new Response(
          JSON.stringify(directory(0, [], ["access.roles.manage"])),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
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
    new Response(
      JSON.stringify(directory(0, [ownerGrant], ["access.roles.manage"])),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  await new Promise((r) => setTimeout(r, 50));

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
        new Response(
          JSON.stringify(directory(0, [ownerGrant], ["access.roles.manage"])),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
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
          JSON.stringify(directory(1, [ownerGrant], ["access.roles.manage", "access.users.manage"])),
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
  await new Promise((r) => setTimeout(r, 50));

  expect(screen.getByText("You cannot manage roles")).toBeTruthy();
  expect(screen.queryByText(USER, { exact: false })).toBeNull();
  expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create custom role" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
});
