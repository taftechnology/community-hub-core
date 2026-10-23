import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach } from "vitest";

import { router, Shell } from "./shell";

const EMAIL = "ada@example.com";
const CODE = "123456";
const TOKEN = "token-1";
const REFRESH = "refresh-1";

function resultIds(
  results: axe.AxeResults,
  bucket: "passes" | "violations" | "incomplete" | "inapplicable",
): string[] {
  return results[bucket].map((entry) => entry.id);
}

async function showSignIn(): Promise<void> {
  await router.navigate("/sign-in");
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

it("stores the access token only and opens Users and Roles", async () => {
  const writes: unknown[] = [];
  for (const method of ["log", "info", "debug", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      writes.push(...args);
    });
  }
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/email-otp/start")) {
      return new Response(null, { status: 200 });
    }
    if (url.endsWith("/v1/auth/email-otp/verify")) {
      return new Response(
        JSON.stringify({
          accessToken: TOKEN,
          userId: "00000000-0000-4000-8000-000000000002",
          refreshToken: REFRESH,
          expiresIn: 900,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected ${url}`);
  });

  await showSignIn();
  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: EMAIL } });
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), { target: { value: CODE } });
  fireEvent.click(screen.getByRole("button", { name: "Verify" }));

  expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeTruthy();
  expect(router.state.location.pathname).toBe("/settings/users");
  expect(sessionStorage.getItem("community-hub.access-token")).toBe(TOKEN);
  expect(sessionStorage.getItem("community-hub.email")).toBeNull();
  expect(sessionStorage.length).toBe(1);
  const verify = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/email-otp/verify"));
  expect(String(verify?.[0])).toBe("https://auth.au.example.test/v1/auth/email-otp/verify");
  const dumped = writes.map((value) => String(value)).join("\n");
  expect(dumped).not.toContain(EMAIL);
  expect(dumped).not.toContain(TOKEN);
  expect(dumped).not.toContain(REFRESH);
  expect(dumped).not.toContain(CODE);
  expect(document.body.textContent).not.toContain(REFRESH);
});

it("shows Sign-in failed and hides the address", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  await showSignIn();
  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: EMAIL } });
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), { target: { value: CODE } });
  fireEvent.click(screen.getByRole("button", { name: "Verify" }));

  expect(await screen.findByText("Sign-in failed")).toBeTruthy();
  expect(document.body.textContent).not.toContain(EMAIL);
  expect(document.body.textContent).not.toContain(CODE);
  expect(router.state.location.pathname).toBe("/sign-in");
  expect(sessionStorage.length).toBe(0);
});

it("shows Directory unavailable when an origin is missing and does not fetch", async () => {
  vi.stubEnv("VITE_API_ORIGIN", "");
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("fetch called");
  });
  await showSignIn();
  expect(screen.getByText("Directory unavailable")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send code" })).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("names the sign-in controls and reports no axe violations", async () => {
  await router.navigate("/sign-in");
  const { container } = render(<Shell />);
  expect(screen.getByRole("navigation", { name: "Admin" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Email" })).toBeTruthy();
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(resultIds(results, "violations")).toEqual([]);
});

it("shows the code-entry step and no sign-in failed message on 204 start response", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/email-otp/start")) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${url}`);
  });

  await showSignIn();
  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: EMAIL } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  });

  expect(screen.getByRole("textbox", { name: "Code" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Verify" })).toBeTruthy();
  expect(screen.queryByText("Sign-in failed")).toBeNull();
  expect(fetchSpy).toHaveBeenCalled();
});

it("fetches billing status again after sign-in with remembered community", async () => {
  sessionStorage.setItem("community-hub.community", "parish");
  sessionStorage.setItem("community-hub.access-token", "expired-token");

  const billingStatusCalls: { url: string; headers: Headers }[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.endsWith("/v1/billing/status")) {
      billingStatusCalls.push({ url, headers });
      if (billingStatusCalls.length === 1) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          state: "none",
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
    if (url.endsWith("/v1/auth/email-otp/start")) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/v1/auth/email-otp/verify")) {
      return new Response(
        JSON.stringify({
          accessToken: TOKEN,
          userId: "00000000-0000-4000-8000-000000000002",
          refreshToken: REFRESH,
          expiresIn: 900,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/v1/access/grants/list")) {
      return new Response(
        JSON.stringify({
          grants: [],
          customRoles: [],
          catalogue: [],
          builtIn: [],
          userLinks: [],
          permissions: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected ${url}`);
  });

  await showSignIn();

  // Initial billing status call completed and 401 cleared the expired token
  await act(async () => {});
  expect(billingStatusCalls.length).toBe(1);
  expect(sessionStorage.getItem("community-hub.access-token")).toBeNull();

  // Complete sign-in
  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: EMAIL } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), { target: { value: CODE } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
  });

  // Second billing status call with bearer token and banner rendering
  expect(billingStatusCalls.length).toBe(2);
  expect(billingStatusCalls[1]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(await screen.findByText("Choose a plan to start using Community Hub")).toBeTruthy();
});
