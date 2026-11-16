import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { StrictMode } from "react";
import { afterEach, beforeEach } from "vitest";

import { clearInviteToken, getInviteToken, setInviteToken } from "./invite-token";
import { router, Shell } from "./shell";

// Built at run time, so no token-shaped literal is committed.
const INVITE = "v1." + "A".repeat(107);
const SESSION = "session-" + "1";
const ADDRESS = "invitee@example.test";
const CODE = "123456";
const ACCEPT_URL = "https://au.api.example.test/v1/invitations/accept";

const SENTENCE = {
  signIn: "Sign in with the address this invitation was sent to",
  heading: "Accept invitation",
  accepted: "Your invitation was accepted. An administrator will give you access.",
  wrongAddress:
    "This invitation was sent to a different address. Sign out and sign in with that address.",
  noLongerValid: "This invitation is no longer valid. Ask for a new one.",
  readOnly: "Read-only until billing is settled",
  generic: "Something went wrong. Try again.",
};

type Call = { url: string; method: string | undefined; body: string | undefined };

function resultIds(
  results: axe.AxeResults,
  bucket: "passes" | "violations" | "incomplete" | "inapplicable",
): string[] {
  return results[bucket].map((entry) => entry.id);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type FetchOptions = {
  accept: () => Response | Promise<Response>;
  capabilities?: () => Response;
};

function installFetch(options: FetchOptions): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (url.includes("/v1/invitations/accept")) {
      return options.accept();
    }
    if (url.endsWith("/v1/access/capabilities")) {
      return options.capabilities?.() ?? json({ permissions: {}, entitlements: {} });
    }
    if (url.endsWith("/v1/auth/email-otp/start")) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/v1/auth/email-otp/verify")) {
      return json({ accessToken: SESSION, userId: "00000000-0000-4000-8000-000000000002" });
    }
    if (url.endsWith("/v1/auth/session/end")) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/v1/billing/status")) {
      return json({
        state: "ok",
        canView: true,
        canManage: true,
        trial_end: null,
        grace_until: null,
      });
    }
    return new Response(null, { status: 404 });
  });
  return calls;
}

function acceptCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.url.includes("/v1/invitations/accept"));
}

function capabilityCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.url.endsWith("/v1/access/capabilities"));
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

async function mountAccept(strict = false): Promise<HTMLElement> {
  sessionStorage.setItem("community-hub.access-token", SESSION);
  sessionStorage.setItem("community-hub.signout-handle", SESSION);
  setInviteToken(INVITE);
  await router.navigate("/");
  const view = render(
    strict ? (
      <StrictMode>
        <Shell />
      </StrictMode>
    ) : (
      <Shell />
    ),
  );
  await screen.findByRole("button", { name: SENTENCE.heading });
  return view.container;
}

async function clickAccept(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: SENTENCE.heading }));
}

async function signInThroughForm(): Promise<void> {
  await router.navigate("/sign-in");
  render(<Shell />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Email" }), {
    target: { value: ADDRESS },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), { target: { value: CODE } });
  fireEvent.click(screen.getByRole("button", { name: "Verify" }));
}

// Loads the app the way the browser does: through main.tsx, with the fragment in the address.
async function loadThroughMain(): Promise<{
  loadedRouter: typeof router;
  heldToken: () => string | undefined;
}> {
  sessionStorage.setItem("community-hub.access-token", SESSION);
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState(null, "", `/#invite=${INVITE}`);
  vi.resetModules();
  await import("./main");
  const shell = await import("./shell");
  const holder = await import("./invite-token");
  return { loadedRouter: shell.router, heldToken: holder.getInviteToken };
}

beforeEach(async () => {
  sessionStorage.clear();
  clearInviteToken();
  await router.navigate("/");
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  sessionStorage.clear();
  clearInviteToken();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loading from the emailed link", () => {
  it("pin 47a: after load with #invite=<token>, location.hash and router.state.location.hash are both empty", async () => {
    installFetch({ accept: () => json({ communitySlug: "parish" }) });
    const { loadedRouter, heldToken } = await loadThroughMain();

    expect(await screen.findByRole("heading", { name: SENTENCE.heading })).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(loadedRouter.state.location.hash).toBe("");
    expect(window.location.pathname).toBe("/");
    expect(heldToken()).toBe(INVITE);
  });

  it("pin 47b: neither localStorage.setItem nor sessionStorage.setItem ever receives the token", async () => {
    // jsdom has no usable localStorage here, so it is a plain recording stand-in, as in shell.test.
    const store = new Map<string, string>();
    const local = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
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
    const localSetItem = vi.spyOn(local, "setItem");
    vi.stubGlobal("localStorage", local);
    const sessionSetItem = vi.spyOn(Object.getPrototypeOf(window.sessionStorage), "setItem");
    installFetch({ accept: () => json({ communitySlug: "parish" }) });
    await loadThroughMain();

    fireEvent.click(await screen.findByRole("button", { name: SENTENCE.heading }));
    await waitFor(() => {
      expect(sessionStorage.getItem("community-hub.community")).toBe("parish");
    });

    // The spy sees real writes: the access token and the community slug.
    expect(sessionSetItem.mock.calls.length).toBeGreaterThan(0);
    for (const args of [...sessionSetItem.mock.calls, ...localSetItem.mock.calls]) {
      for (const value of args) {
        expect(String(value)).not.toContain(INVITE);
      }
    }
    expect(store.size).toBe(0);
    expect(document.cookie).toBe("");
  });

  it("the token appears in no request URL and in no console call", async () => {
    const writes = captureConsole();
    const calls = installFetch({ accept: () => json({ communitySlug: "parish" }) });
    await mountAccept();
    await clickAccept();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/users");
    });

    expect(acceptCalls(calls)).toHaveLength(1);
    for (const call of calls) {
      expect(call.url).not.toContain(INVITE);
      expect(call.url).not.toContain("?");
    }
    expect(writes.join("\n")).not.toContain(INVITE);
    expect(window.location.href).not.toContain(INVITE);
  });
});

describe("signing in with a token held", () => {
  it("signed out with a token, the sign-in screen is headed with the invitation sentence", async () => {
    installFetch({ accept: () => json({ communitySlug: "parish" }) });
    setInviteToken(INVITE);
    await router.navigate("/");
    render(<Shell />);

    expect(await screen.findByRole("heading", { level: 1, name: SENTENCE.signIn })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(screen.queryByRole("heading", { level: 1, name: "Sign in" })).toBeNull();
  });

  it("after sign-in with a token held, the accept screen shows and not Users and Roles", async () => {
    const calls = installFetch({ accept: () => json({ communitySlug: "parish" }) });
    setInviteToken(INVITE);
    await signInThroughForm();

    expect(await screen.findByRole("heading", { name: SENTENCE.heading })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
    expect(screen.queryByRole("heading", { name: "Users & Roles" })).toBeNull();
    expect(acceptCalls(calls)).toHaveLength(0);
  });

  it("a normal sign-in with no token still lands on Users and Roles", async () => {
    installFetch({ accept: () => json({ communitySlug: "parish" }) });
    await signInThroughForm();

    expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/settings/users");
    expect(screen.queryByRole("heading", { name: SENTENCE.heading })).toBeNull();
  });
});

describe("the accept screen", () => {
  it("sends exactly { token } in the body of a POST to /v1/invitations/accept", async () => {
    const calls = installFetch({ accept: () => json({ communitySlug: "parish" }) });
    await mountAccept();
    await clickAccept();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/users");
    });

    const sent = acceptCalls(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(ACCEPT_URL);
    expect(sent[0]?.method).toBe("POST");
    expect(JSON.parse(sent[0]?.body ?? "null")).toEqual({ token: INVITE });
  });

  it("200 switches to the returned community, loads capabilities and lands on Users and Roles", async () => {
    const calls = installFetch({ accept: () => json({ communitySlug: "parish" }) });
    await mountAccept();
    await clickAccept();

    expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/settings/users");
    expect(sessionStorage.getItem("community-hub.community")).toBe("parish");
    // One request from the accept screen, which needs the status, and one from the shell's own
    // capabilities loader when the community changes.
    const loads = capabilityCalls(calls);
    expect(loads).toHaveLength(2);
    for (const load of loads) {
      expect(JSON.parse(load.body ?? "null")).toEqual({ communitySlug: "parish" });
    }
  });

  it("200 then capabilities 403 shows that the invitation was accepted", async () => {
    installFetch({
      accept: () => json({ communitySlug: "parish" }),
      capabilities: () => new Response(null, { status: 403 }),
    });
    await mountAccept();
    await clickAccept();

    expect(await screen.findByText(SENTENCE.accepted)).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
    expect(sessionStorage.getItem("community-hub.community")).toBe("parish");
  });

  it("403 wrong_address shows the different-address sentence and a Sign out button, never an address", async () => {
    installFetch({
      accept: () => json({ error: "wrong_address", email: ADDRESS }, 403),
    });
    await mountAccept();
    await clickAccept();

    expect(await screen.findByText(SENTENCE.wrongAddress)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(document.body.textContent).not.toContain(ADDRESS);
    expect(screen.queryByText(SENTENCE.generic)).toBeNull();
  });

  it("the Sign out button on the wrong-address screen ends the session", async () => {
    const calls = installFetch({ accept: () => json({ error: "wrong_address" }, 403) });
    const assign = vi.fn();
    const here = window.location;
    vi.stubGlobal("location", {
      ancestorOrigins: here.ancestorOrigins,
      href: here.href,
      origin: here.origin,
      protocol: here.protocol,
      host: here.host,
      hostname: here.hostname,
      port: here.port,
      pathname: here.pathname,
      search: here.search,
      hash: here.hash,
      assign,
      replace: here.replace.bind(here),
      reload: here.reload.bind(here),
    });
    await mountAccept();
    await clickAccept();
    await screen.findByText(SENTENCE.wrongAddress);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith("/sign-in");
    });
    expect(calls.filter((call) => call.url.endsWith("/v1/auth/session/end"))).toHaveLength(1);
  });

  it("404 invitation_invalid shows the no longer valid sentence", async () => {
    installFetch({ accept: () => json({ error: "invitation_invalid" }, 404) });
    await mountAccept();
    await clickAccept();

    expect(await screen.findByText(SENTENCE.noLongerValid)).toBeTruthy();
    expect(screen.queryByRole("button", { name: SENTENCE.heading })).toBeNull();
  });

  it("409 invitation_void shows the no longer valid sentence", async () => {
    installFetch({ accept: () => json({ error: "invitation_void" }, 409) });
    await mountAccept();
    await clickAccept();

    expect(await screen.findByText(SENTENCE.noLongerValid)).toBeTruthy();
    expect(screen.queryByRole("button", { name: SENTENCE.heading })).toBeNull();
  });

  it("402 shows the billing read-only notice", async () => {
    installFetch({ accept: () => new Response(null, { status: 402 }) });
    await mountAccept();
    await clickAccept();

    expect(await screen.findByText(SENTENCE.readOnly)).toBeTruthy();
    expect(screen.queryByText(SENTENCE.generic)).toBeNull();
  });

  it("a 500 shows the generic sentence", async () => {
    installFetch({ accept: () => new Response(null, { status: 500 }) });
    await mountAccept();
    await clickAccept();

    expect(await screen.findByText(SENTENCE.generic)).toBeTruthy();
    expect(screen.getByRole("button", { name: SENTENCE.heading })).toBeTruthy();
  });

  it("a network failure shows the generic sentence", async () => {
    installFetch({
      accept: () => {
        throw new TypeError("network down");
      },
    });
    await mountAccept();
    await clickAccept();

    expect(await screen.findByText(SENTENCE.generic)).toBeTruthy();
    expect(screen.getByRole("button", { name: SENTENCE.heading })).toBeTruthy();
  });
});

describe("the token after an answer", () => {
  it("clears the token after 200", async () => {
    installFetch({ accept: () => json({ communitySlug: "parish" }) });
    await mountAccept();
    await clickAccept();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/users");
    });

    expect(getInviteToken()).toBeUndefined();
  });

  it("clears the token after wrong_address", async () => {
    installFetch({ accept: () => json({ error: "wrong_address" }, 403) });
    await mountAccept();
    await clickAccept();
    await screen.findByText(SENTENCE.wrongAddress);

    expect(getInviteToken()).toBeUndefined();
  });

  it("clears the token after invitation_invalid", async () => {
    installFetch({ accept: () => json({ error: "invitation_invalid" }, 404) });
    await mountAccept();
    await clickAccept();
    await screen.findByText(SENTENCE.noLongerValid);

    expect(getInviteToken()).toBeUndefined();
  });

  it("clears the token after invitation_void", async () => {
    installFetch({ accept: () => json({ error: "invitation_void" }, 409) });
    await mountAccept();
    await clickAccept();
    await screen.findByText(SENTENCE.noLongerValid);

    expect(getInviteToken()).toBeUndefined();
  });

  it("clears the token after 402", async () => {
    installFetch({ accept: () => new Response(null, { status: 402 }) });
    await mountAccept();
    await clickAccept();
    await screen.findByText(SENTENCE.readOnly);

    expect(getInviteToken()).toBeUndefined();
  });

  it("keeps the token after a 500 and sends it again on retry", async () => {
    let answers = 0;
    const calls = installFetch({
      accept: () => {
        answers += 1;
        return answers === 1
          ? new Response(null, { status: 500 })
          : json({ communitySlug: "parish" });
      },
    });
    await mountAccept();
    await clickAccept();
    await screen.findByText(SENTENCE.generic);

    expect(getInviteToken()).toBe(INVITE);

    await clickAccept();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/users");
    });
    const sent = acceptCalls(calls);
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1]?.body ?? "null")).toEqual({ token: INVITE });
    expect(getInviteToken()).toBeUndefined();
  });

  it("keeps the token after a network failure", async () => {
    installFetch({
      accept: () => {
        throw new TypeError("network down");
      },
    });
    await mountAccept();
    await clickAccept();
    await screen.findByText(SENTENCE.generic);

    expect(getInviteToken()).toBe(INVITE);
  });
});

describe("one request per click", () => {
  it("sends one accept request per click under StrictMode", async () => {
    const calls = installFetch({ accept: () => json({ error: "invitation_invalid" }, 404) });
    await mountAccept(true);
    await clickAccept();
    await screen.findByText(SENTENCE.noLongerValid);

    expect(acceptCalls(calls)).toHaveLength(1);
  });

  it("a second click while the first is in flight sends nothing", async () => {
    const pending = deferred<Response>();
    const calls = installFetch({ accept: () => pending.promise });
    await mountAccept(true);
    const button = await screen.findByRole("button", { name: SENTENCE.heading });

    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => {});
    expect(acceptCalls(calls)).toHaveLength(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      pending.resolve(json({ error: "invitation_invalid" }, 404));
    });
    await screen.findByText(SENTENCE.noLongerValid);
    expect(acceptCalls(calls)).toHaveLength(1);
  });
});

describe("accessibility", () => {
  it("has no axe violations on the accept screen", async () => {
    installFetch({ accept: () => json({ communitySlug: "parish" }) });
    const container = await mountAccept();

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("has no axe violations on the token sign-in heading", async () => {
    installFetch({ accept: () => json({ communitySlug: "parish" }) });
    setInviteToken(INVITE);
    await router.navigate("/sign-in");
    const { container } = render(<Shell />);
    await screen.findByRole("heading", { level: 1, name: SENTENCE.signIn });

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });
});
