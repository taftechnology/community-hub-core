import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

function directory(customRoleCount: number, grants: unknown[]) {
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
  fireEvent.click(screen.getByRole("button", { name: "Load" }));

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
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  expect(await screen.findByText("Custom role limit reached")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create custom role" })).toBeNull();
  expect(document.body.textContent).not.toContain(EMAIL);
});

it("offers ownership when the community has no grants", async () => {
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
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  expect(await screen.findByText("No role grants")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Become the owner" })).toBeTruthy();
});

it("shows the role errors for 403 and 409", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 403 }));
  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  expect(await screen.findByText("You cannot manage roles")).toBeTruthy();

  cleanup();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 409 }));
  await showUsers();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  expect(await screen.findByText("That change was rejected")).toBeTruthy();
});
