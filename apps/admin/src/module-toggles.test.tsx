import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach } from "vitest";

import { router, Shell } from "./shell";

const TOKEN = "token-1";
const EMAIL = "ada@example.com";

function resultIds(
  results: axe.AxeResults,
  bucket: "passes" | "violations" | "incomplete" | "inapplicable",
): string[] {
  return results[bucket].map((entry) => entry.id);
}

async function showModules(): Promise<HTMLElement> {
  await router.navigate("/settings/modules");
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
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
  fireEvent.click(await screen.findByRole("switch", { name: "people.directory" }));
  expect(await screen.findByText("That change was rejected")).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "people.households" })).toBeNull();

  cleanup();
  fetchSpy.mockRejectedValue(new Error("offline"));
  await showModules();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
  fireEvent.click(await screen.findByRole("switch", { name: "people.directory" }));

  const call = fetchSpy.mock.calls.find((c) =>
    String(c[0]).includes("/v1/entitlements/toggle"),
  );
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

it("reports no axe violations with switches and without", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        keys: [{ key: "people.directory", enabled: true }],
        canManage: true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  const withSwitches = await showModules();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
  expect(await screen.findByRole("switch", { name: "people.directory" })).toBeTruthy();
  const managed = await axe.run(withSwitches, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(resultIds(managed, "violations")).toEqual([]);

  cleanup();
  fetchSpy.mockResolvedValue(
    new Response(
      JSON.stringify({
        keys: [{ key: "people.directory", enabled: true }],
        canManage: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  const withoutSwitches = await showModules();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
  expect(await screen.findByText("people.directory")).toBeTruthy();
  expect(screen.queryByRole("switch")).toBeNull();
  const viewOnly = await axe.run(withoutSwitches, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(resultIds(viewOnly, "violations")).toEqual([]);
});

it("loads from the context slug with no slug field of its own", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  sessionStorage.setItem("community-hub.community", "parish");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        keys: [{ key: "people.directory", enabled: true }],
        canManage: true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  await showModules();
  expect(within(screen.getByRole("main")).queryByRole("textbox", { name: "Community" })).toBeNull();
  expect(await screen.findByRole("switch", { name: "people.directory" })).toBeTruthy();
});

it("clears rows and switches when switching to a community that answers 403", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    if (body.communitySlug === "parish") {
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
    return Promise.resolve(new Response(null, { status: 403 }));
  });

  await showModules();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByRole("switch", { name: "people.directory" })).toBeTruthy();

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("You cannot manage modules")).toBeTruthy();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.queryByText("people.directory")).toBeNull();
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
          JSON.stringify({ keys: [], canManage: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });

  await showModules();

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "abbey" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("No modules are allocated.")).toBeTruthy();

  resolveCathedral(
    new Response(
      JSON.stringify({
        keys: [{ key: "people.directory", enabled: true }],
        canManage: true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  await act(async () => {
    await cathedralPromise;
  });

  expect(screen.getByText("No modules are allocated.")).toBeTruthy();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.queryByText("people.directory")).toBeNull();
});

it("retries fetching when Set is pressed again with the same slug", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let attempts = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    if (String(input).includes("/v1/entitlements/list")) {
      attempts++;
      if (attempts === 1) {
        return Promise.resolve(new Response(null, { status: 403 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ keys: [], canManage: true }),
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
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("You cannot manage modules")).toBeTruthy();
  expect(attempts).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("No modules are allocated.")).toBeTruthy();
  expect(attempts).toBe(2);
});

it("ignores a write that finishes after switching to a forbidden community", async () => {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  let resolveToggle!: (value: Response) => void;
  const togglePromise = new Promise<Response>((resolve) => {
    resolveToggle = resolve;
  });

  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/entitlements/toggle")) {
      return togglePromise;
    }
    const body = JSON.parse(String((init as RequestInit).body));
    if (body.communitySlug === "parish") {
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
    return Promise.resolve(new Response(null, { status: 403 }));
  });

  await showModules();
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "parish" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  const toggle = await screen.findByRole("switch", { name: "people.directory" });
  fireEvent.click(toggle);

  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: "cathedral" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));

  expect(await screen.findByText("You cannot manage modules")).toBeTruthy();

  resolveToggle(new Response(null, { status: 200 }));
  await act(async () => {
    await togglePromise;
  });

  expect(screen.getByText("You cannot manage modules")).toBeTruthy();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.queryByText("people.directory")).toBeNull();
});
