import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, type Mock } from "vitest";

import { router, Shell } from "./shell";

const EMAIL = "ada@example.com";
const CODE = "123456";
const TOKEN = "token-1";
const REFRESH = "refresh-1";
// The token an email code gives: a restricted pre-2FA session, kept in memory only.
const PRE_TOKEN = "pre-token-" + "1";
const TOTP_CODE = "654321";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const RP_ID = "admin.example.test";

function resultIds(
  results: axe.AxeResults,
  bucket: "passes" | "violations" | "incomplete" | "inapplicable",
): string[] {
  return results[bucket].map((entry) => entry.id);
}

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => {
      store.set(key, String(val));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

let storage: Storage;

async function showSignIn(): Promise<void> {
  await router.navigate("/sign-in");
  render(<Shell />);
}

// The answer to a right email code: the second step, not a session.
function preSessionAnswer(): Response {
  return new Response(
    JSON.stringify({
      secondFactor: "verify",
      methods: ["totp"],
      passkeysAvailable: false,
      accessToken: PRE_TOKEN,
      expiresIn: 900,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// The answer to a right second step: the admin session.
function adminSessionAnswer(): Response {
  return new Response(
    JSON.stringify({ userId: USER_ID, accessToken: TOKEN, refreshToken: REFRESH, expiresIn: 900 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function completeSecondStep(): Promise<void> {
  fireEvent.change(await screen.findByRole("textbox", { name: "Authenticator code" }), {
    target: { value: TOTP_CODE },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  });
}

function captureConsole(): string[] {
  const writes: string[] = [];
  for (const method of ["log", "info", "debug", "warn", "error", "trace"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      writes.push(args.map((value) => String(value)).join(" "));
    });
  }
  return writes;
}

function b64u(...values: number[]): string {
  return Buffer.from(values).toString("base64url");
}

function buffer(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

type GetFn = (options?: CredentialRequestOptions) => Promise<unknown>;

function stubWebAuthn(): { get: Mock<GetFn> } {
  const get = vi.fn<GetFn>();
  vi.stubGlobal("PublicKeyCredential", class PublicKeyCredentialStandIn {});
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { get, create: vi.fn() },
  });
  return { get };
}

beforeEach(async () => {
  storage = createStorage();
  vi.stubGlobal("localStorage", storage);
  sessionStorage.clear();
  await router.navigate("/");
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  Reflect.deleteProperty(navigator, "credentials");
  vi.unstubAllGlobals();
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
      return preSessionAnswer();
    }
    if (url.endsWith("/v1/auth/second-factor/verify")) {
      return adminSessionAnswer();
    }
    throw new Error(`unexpected ${url}`);
  });

  await showSignIn();
  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: EMAIL } });
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), { target: { value: CODE } });
  fireEvent.click(screen.getByRole("button", { name: "Verify" }));
  await completeSecondStep();

  expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeTruthy();
  expect(router.state.location.pathname).toBe("/settings/users");
  expect(sessionStorage.getItem("community-hub.access-token")).toBe(TOKEN);
  expect(sessionStorage.getItem("community-hub.signout-handle")).toBe(TOKEN);
  expect(sessionStorage.getItem("community-hub.email")).toBeNull();
  expect(sessionStorage.length).toBe(2);
  const verify = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/email-otp/verify"));
  expect(String(verify?.[0])).toBe("https://auth.au.example.test/v1/auth/email-otp/verify");
  const second = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/second-factor/"));
  expect(String(second?.[0])).toBe("https://auth.au.example.test/v1/auth/second-factor/verify");
  const dumped = writes.map((value) => String(value)).join("\n");
  expect(dumped).not.toContain(EMAIL);
  expect(dumped).not.toContain(TOKEN);
  expect(dumped).not.toContain(PRE_TOKEN);
  expect(dumped).not.toContain(REFRESH);
  expect(dumped).not.toContain(CODE);
  expect(dumped).not.toContain(TOTP_CODE);
  expect(document.body.textContent).not.toContain(REFRESH);
  expect(document.body.textContent).not.toContain(PRE_TOKEN);
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
  expect(screen.queryByRole("navigation", { name: "Admin" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Dark mode" })).toBeNull();
  const headings = screen.getAllByRole("heading", { level: 1 });
  expect(headings).toHaveLength(1);
  expect(headings[0]?.textContent).toBe("Sign in");
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
      return preSessionAnswer();
    }
    if (url.endsWith("/v1/auth/second-factor/verify")) {
      return adminSessionAnswer();
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
  await completeSecondStep();

  // Second billing status call with bearer token and banner rendering
  await waitFor(() => {
    expect(billingStatusCalls.length).toBe(2);
  });
  expect(billingStatusCalls.length).toBe(2);
  expect(billingStatusCalls[1]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(await screen.findByText("Choose a plan to start using Community Hub")).toBeTruthy();
});

it("Pin 11a: after sign-in verify, sessionStorage has the handle and localStorage holds no key other than community-hub.theme", async () => {
  localStorage.setItem("community-hub.theme", "dark");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/email-otp/start")) {
      return new Response(null, { status: 200 });
    }
    if (url.endsWith("/v1/auth/email-otp/verify")) {
      return preSessionAnswer();
    }
    if (url.endsWith("/v1/auth/second-factor/verify")) {
      return adminSessionAnswer();
    }
    throw new Error(`unexpected ${url}`);
  });

  await showSignIn();
  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: EMAIL } });
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), { target: { value: CODE } });
  fireEvent.click(screen.getByRole("button", { name: "Verify" }));
  await completeSecondStep();

  expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeTruthy();
  expect(sessionStorage.getItem("community-hub.signout-handle")).toBe(TOKEN);

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    expect(key).toBe("community-hub.theme");
  }
  expect(localStorage.getItem("community-hub.signout-handle")).toBeNull();
});

it("shows unconfirmed signout Alert when ?signout=unconfirmed is present", async () => {
  await router.navigate("/sign-in?signout=unconfirmed");
  render(<Shell />);

  const alert = screen.getByRole("alert");
  expect(alert).toBeTruthy();
  expect(alert.textContent).toBe(
    "We couldn't confirm you signed out. Close your browser to end the session.",
  );
});

it("shows no unconfirmed signout message when signout flag is omitted or has other values", async () => {
  await router.navigate("/sign-in");
  const { unmount } = render(<Shell />);
  expect(
    screen.queryByText(
      "We couldn't confirm you signed out. Close your browser to end the session.",
    ),
  ).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  unmount();

  await router.navigate("/sign-in?signout=other");
  const { unmount: unmountOther } = render(<Shell />);
  expect(
    screen.queryByText(
      "We couldn't confirm you signed out. Close your browser to end the session.",
    ),
  ).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  unmountOther();

  await router.navigate("/sign-in?signout=<script>alert(1)</script>");
  render(<Shell />);
  expect(
    screen.queryByText(
      "We couldn't confirm you signed out. Close your browser to end the session.",
    ),
  ).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain("<script>");
});

it("renders Email and Code inputs through Input component with data-slot input", async () => {
  await showSignIn();
  const emailInput = screen.getByRole("textbox", { name: "Email" });
  const codeInput = screen.getByRole("textbox", { name: "Code" });
  expect(emailInput.getAttribute("data-slot")).toBe("input");
  expect(codeInput.getAttribute("data-slot")).toBe("input");
});

it("keeps the pre-2FA token out of session storage", async () => {
  const writes = captureConsole();
  const sessionWrites = vi.spyOn(Object.getPrototypeOf(window.sessionStorage), "setItem");
  const localWrites = vi.spyOn(storage, "setItem");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/email-otp/start")) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/v1/auth/email-otp/verify")) {
      return preSessionAnswer();
    }
    if (url.endsWith("/v1/auth/session/end")) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${url}`);
  });

  function expectNothingKept(): void {
    expect(sessionStorage.length).toBe(0);
    expect(storage.length).toBe(0);
    expect(sessionWrites).not.toHaveBeenCalled();
    expect(localWrites).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
    expect(window.location.href).not.toContain(PRE_TOKEN);
    expect(document.title).not.toContain(PRE_TOKEN);
    expect(document.body.textContent).not.toContain(PRE_TOKEN);
    expect(writes.join("\n")).not.toContain(PRE_TOKEN);
  }

  await showSignIn();
  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: EMAIL } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), { target: { value: CODE } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
  });

  // The second step is showing, and the token it holds is in memory only.
  await screen.findByRole("heading", { name: "Confirm it's you" });
  expectNothingKept();

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });
  await screen.findByRole("textbox", { name: "Email" });
  expectNothingKept();
});

it("hides the passkey button when passkeys are not available", async () => {
  let optionCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/passkey/authenticate/options")) {
      optionCalls += 1;
      return new Response(null, { status: 404 });
    }
    throw new Error(`unexpected ${url}`);
  });

  // A browser with no WebAuthn: there is no button and nothing is asked of the service.
  await showSignIn();
  expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
  expect(optionCalls).toBe(0);
  cleanup();

  // A browser with WebAuthn shows it, and it goes when the service answers 404.
  const { get } = stubWebAuthn();
  await showSignIn();
  const button = screen.getByRole("button", { name: "Sign in with a passkey" });
  expect(button).toBeTruthy();
  await act(async () => {
    fireEvent.click(button);
  });
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
  });
  expect(optionCalls).toBe(1);
  expect(get).not.toHaveBeenCalled();
  expect(sessionStorage.length).toBe(0);
  expect(screen.getByRole("alert").textContent).toBe(
    "Passkey sign-in isn't available. Use an email code.",
  );
  expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeNull();
});

it("signs in with a passkey and opens Users and Roles", async () => {
  const { get } = stubWebAuthn();
  get.mockResolvedValue({
    id: "ignored",
    type: "public-key",
    rawId: buffer(1, 2, 3),
    response: {
      clientDataJSON: buffer(4, 5),
      authenticatorData: buffer(6, 7, 8),
      signature: buffer(9),
      userHandle: null,
    },
  });
  const sent: { url: string; method: string | undefined; headers: Headers; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/auth/")) {
      sent.push({
        url,
        method: init?.method,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      });
    }
    if (url.endsWith("/v1/auth/passkey/authenticate/options")) {
      return new Response(
        JSON.stringify({ challenge: b64u(1, 1, 2, 3), rpId: RP_ID, userVerification: "required" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/v1/auth/passkey/authenticate/verify")) {
      return adminSessionAnswer();
    }
    throw new Error(`unexpected ${url}`);
  });

  await showSignIn();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
  });

  expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeTruthy();
  expect(router.state.location.pathname).toBe("/settings/users");
  expect(sent.map((call) => call.url)).toEqual([
    "https://auth.au.example.test/v1/auth/passkey/authenticate/options",
    "https://auth.au.example.test/v1/auth/passkey/authenticate/verify",
  ]);
  expect(sent[0]?.method).toBe("POST");
  expect(sent[0]?.body).toEqual({});
  expect(sent[1]?.body).toEqual({
    credentialId: b64u(1, 2, 3),
    clientDataJSON: b64u(4, 5),
    authenticatorData: b64u(6, 7, 8),
    signature: b64u(9),
  });
  expect(sent[0]?.headers.get("authorization")).toBeNull();
  expect(sent[1]?.headers.get("authorization")).toBeNull();
  expect(get).toHaveBeenCalledTimes(1);
  const asked = get.mock.calls[0]?.[0]?.publicKey;
  expect(asked?.rpId).toBe(RP_ID);
  expect(asked?.userVerification).toBe("required");
  expect(Array.from(new Uint8Array(asked?.challenge as ArrayBuffer))).toEqual([1, 1, 2, 3]);
  expect(sessionStorage.getItem("community-hub.access-token")).toBe(TOKEN);
  expect(sessionStorage.getItem("community-hub.signout-handle")).toBe(TOKEN);
  expect(sessionStorage.length).toBe(2);
  expect(document.body.textContent).not.toContain(REFRESH);
});

it("shows Sign-in failed when the passkey is refused", async () => {
  const { get } = stubWebAuthn();
  get.mockResolvedValue({
    id: "ignored",
    type: "public-key",
    rawId: buffer(1),
    response: {
      clientDataJSON: buffer(2),
      authenticatorData: buffer(3),
      signature: buffer(4),
      userHandle: null,
    },
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/passkey/authenticate/options")) {
      return new Response(
        JSON.stringify({ challenge: b64u(1), rpId: RP_ID, userVerification: "required" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/v1/auth/passkey/authenticate/verify")) {
      return new Response(null, { status: 401 });
    }
    throw new Error(`unexpected ${url}`);
  });

  await showSignIn();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
  });

  await screen.findByText("Sign-in failed");
  expect(screen.getByRole("alert").textContent).toBe("Sign-in failed");
  expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).not.toBeNull();
  expect(sessionStorage.length).toBe(0);
  expect(router.state.location.pathname).toBe("/sign-in");
});

it("shows Sign-in failed when the passkey dialog is dismissed", async () => {
  const { get } = stubWebAuthn();
  get.mockRejectedValue(new DOMException("dismissed", "NotAllowedError"));
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/passkey/authenticate/options")) {
      return new Response(
        JSON.stringify({ challenge: b64u(1), rpId: RP_ID, userVerification: "required" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected ${url}`);
  });

  await showSignIn();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
  });

  await screen.findByText("Sign-in failed");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(sessionStorage.length).toBe(0);
});

it("stores nothing from a verify answer that has no second-factor state", async () => {
  // The shape the answer had before the second step existed: a session, no second-factor fields.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/email-otp/verify")) {
      return adminSessionAnswer();
    }
    throw new Error(`unexpected ${url}`);
  });

  await showSignIn();
  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: EMAIL } });
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), { target: { value: CODE } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
  });

  await screen.findByText("Sign-in failed");
  expect(sessionStorage.length).toBe(0);
  expect(router.state.location.pathname).toBe("/sign-in");
  expect(screen.queryByRole("heading", { name: "Confirm it's you" })).toBeNull();
});

it("stores nothing from a verify answer that lists a method it does not know", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/email-otp/verify")) {
      return new Response(
        JSON.stringify({
          secondFactor: "verify",
          methods: ["totp", "sms"],
          passkeysAvailable: false,
          accessToken: PRE_TOKEN,
          expiresIn: 900,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected ${url}`);
  });

  await showSignIn();
  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: EMAIL } });
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), { target: { value: CODE } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
  });

  await screen.findByText("Sign-in failed");
  expect(sessionStorage.length).toBe(0);
  expect(screen.queryByRole("heading", { name: "Confirm it's you" })).toBeNull();
});

it("passes axe with the passkey button showing", async () => {
  stubWebAuthn();
  await router.navigate("/sign-in");
  const { container } = render(<Shell />);
  expect(screen.getByRole("button", { name: "Sign in with a passkey" })).toBeTruthy();
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  expect(resultIds(results, "violations")).toEqual([]);
});
