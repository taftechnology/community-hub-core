import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

import { router, Shell } from "./shell";

const TOKEN = "token-1";
const EMAIL = "ada@example.com";

async function showModules(): Promise<void> {
  await router.navigate("/settings/modules");
  render(<Shell />);
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
  await showModules();
  expect(screen.getByRole("heading", { name: "Module Toggles" })).toBeTruthy();
  expect(screen.getByText("Sign in required")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in");
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("loads the community and shows no modules when none are allocated", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ keys: [], canManage: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await showModules();
  expect(screen.queryByText("No modules are allocated.")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  expect(await screen.findByText("No modules are allocated.")).toBeTruthy();
  expect(document.body.textContent).not.toContain("Upgrade");
  expect(document.body.textContent).not.toContain("$");

  const call = fetchSpy.mock.calls[0];
  expect(String(call?.[0])).toBe("https://au.api.example.test/v1/entitlements/list");
  expect(String(call?.[0])).not.toContain("parish");
  expect(String(call?.[0])).not.toContain(TOKEN);
  const init = call?.[1] as RequestInit;
  expect(init.method).toBe("POST");
  expect(init.body).toBe(JSON.stringify({ communitySlug: "parish" }));
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
});

it("names a switch with the key when the caller can manage", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        keys: [
          {
            key: "people.directory",
            enabled: true,
            email: EMAIL,
            givenName: "Ada Person",
            phone: "+61400000000",
          },
        ],
        canManage: true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  await showModules();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  expect(await screen.findByRole("switch", { name: "people.directory" })).toBeTruthy();
  expect(document.body.textContent).not.toContain(EMAIL);
  expect(document.body.textContent).not.toContain("Ada Person");
  expect(document.body.textContent).not.toContain("+61400000000");
  expect(document.body.textContent).not.toContain("Upgrade");
  expect(document.body.textContent).not.toContain("$");
});

it("renders the key without a switch when canManage is false or missing", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(
        JSON.stringify({ keys: [{ key: "people.directory", enabled: true }], canManage: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  await showModules();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  expect(await screen.findByText("people.directory")).toBeTruthy();
  expect(screen.queryByRole("switch")).toBeNull();

  cleanup();
  fetchSpy.mockResolvedValue(
    new Response(JSON.stringify({ keys: [{ key: "people.directory", enabled: false }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await showModules();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  expect(await screen.findByText("people.directory")).toBeTruthy();
  expect(screen.queryByRole("switch")).toBeNull();
});

it("shows the module error for 403", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 403 }));
  await showModules();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  expect(await screen.findByText("You cannot manage modules")).toBeTruthy();
});

it("shows a rejected change and a network failure", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.endsWith("/v1/entitlements/list")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            keys: [{ key: "people.directory", enabled: true }],
            canManage: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 400 }));
  });
  await showModules();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  fireEvent.click(await screen.findByRole("switch", { name: "people.directory" }));
  expect(await screen.findByText("That change was rejected")).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "people.households" })).toBeNull();

  cleanup();
  fetchSpy.mockRejectedValue(new Error("offline"));
  await showModules();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  expect(await screen.findByText("Directory unavailable")).toBeTruthy();
});

it("posts the toggle and keeps the slug out of the url", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.endsWith("/v1/entitlements/list")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            keys: [{ key: "people.directory", enabled: true }],
            canManage: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 200 }));
  });
  await showModules();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  fireEvent.click(await screen.findByRole("switch", { name: "people.directory" }));

  const call = fetchSpy.mock.calls[1];
  expect(String(call?.[0])).toBe("https://au.api.example.test/v1/entitlements/toggle");
  expect(String(call?.[0])).not.toContain("parish");
  expect(String(call?.[0])).not.toContain(TOKEN);
  expect(String(call?.[0])).not.toContain("people.directory");
  const init = call?.[1] as RequestInit;
  expect(init.method).toBe("POST");
  expect(init.body).toBe(
    JSON.stringify({ communitySlug: "parish", key: "people.directory", enabled: false }),
  );
});
