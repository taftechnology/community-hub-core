import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { toString as qrToString } from "qrcode";
import { StrictMode } from "react";
import { afterEach, beforeEach, type Mock } from "vitest";

import { router, Shell } from "./shell";

// Everything below is synthetic. Tokens, the TOTP keys and the backup codes are built at run time,
// so no key-shaped or code-shaped literal is committed.
const AUTH = "https://auth.au.example.test";
const API = "https://au.api.example.test";
const ACCESS_KEY = "community-hub.access-token";
const HANDLE_KEY = "community-hub.signout-handle";
const TOKEN = "admin-token-" + "1";
const TOTP_CODE = "654321";
const RP_ID = "admin.example.test";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
// The ten codes a new set of backup codes arrives as.
const NEW_BACKUP_CODES = Array.from({ length: 10 }, (_, index) =>
  BASE32.slice(index + 7, index + 19),
);

const MESSAGE = {
  wrong: "That code didn't work.",
  limited: "Too many tries. Try again later.",
  generic: "Something went wrong. Try again.",
  wrongSetupCode: "That code didn't work. Check the time on your phone and try again.",
  lastFactor: "You need at least one way to confirm it's you",
  passkeyGone: "That passkey is no longer there",
  appGone: "Your authenticator app is no longer there",
  passkeyNotSaved: "The passkey wasn't saved. Try again.",
  passkeysUnavailable: "Passkeys aren't available here.",
  windowEnded: "The recovery window has ended. Sign in again to make changes.",
  noPasskeyHere: "This browser can't use passkeys. Try another browser or device.",
  recovery:
    "You signed in with a backup code. For a short time you can set up your sign-in methods again: replace your authenticator app, add or remove a passkey, or make new backup codes.",
};

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let out = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32.charAt((buffer >>> bits) & 31);
    }
  }
  return bits > 0 ? out + BASE32.charAt((buffer << (5 - bits)) & 31) : out;
}

// The key a new authenticator app is set up with.
const SECRET = base32(Uint8Array.from({ length: 20 }, (_, index) => (index * 13 + 7) % 256));
const OTPAUTH =
  "otpauth://totp/Community%20Hub?secret=" +
  SECRET +
  "&issuer=Community%20Hub&algorithm=SHA1&digits=6&period=30";
// A different key, used only to prove that the list never shows one.
const LISTED_SECRET = base32(Uint8Array.from({ length: 20 }, (_, index) => (index * 29 + 3) % 256));

function groupsOfFour(value: string): string {
  return (value.match(/.{1,4}/g) ?? []).join(" ");
}

const APP_AT = "2026-03-04T05:06:07.000Z";
const KEY_A = { id: "00000000-0000-4000-8000-0000000000a1", createdAt: "2026-05-06T07:08:09.000Z" };
const KEY_B = { id: "00000000-0000-4000-8000-0000000000b2", createdAt: "2026-07-08T09:10:11.000Z" };

function dateOf(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

// Times in the answers are read against the real clock, so they are built from it with room to spare.
function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function listBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    totp: { confirmedAt: APP_AT },
    passkeys: [KEY_A],
    backupCodesLeft: 8,
    freshUntil: null,
    recoveryUntil: null,
    ...over,
  };
}

function resultIds(
  results: axe.AxeResults,
  bucket: "passes" | "violations" | "incomplete" | "inapplicable",
): string[] {
  return results[bucket].map((entry) => entry.id);
}

// The container testing-library renders into, which is the context every admin axe test uses.
let view: HTMLElement | undefined;

async function expectNoAxeViolations(): Promise<void> {
  if (view === undefined) {
    throw new Error("nothing is rendered");
  }
  const results = await axe.run(view, { rules: { "color-contrast": { enabled: false } } });
  expect(resultIds(results, "violations")).toEqual([]);
}

// A dialog is drawn outside the container, so the whole body is checked, in light and dark.
async function expectNoAxeViolationsInBody(): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    document.documentElement.dataset.theme = theme;
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(resultIds(results, "violations"), theme).toEqual([]);
  }
  delete document.documentElement.dataset.theme;
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function status(code: number): Response {
  return new Response(null, { status: code });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Call = {
  origin: string;
  path: string;
  method: string;
  headers: Headers;
  body: unknown;
};

type Handler = (call: Call) => Response | Promise<Response>;

const LIST = "GET /v1/auth/second-factor";
const FRESH = "POST /v1/auth/second-factor/fresh";
const FRESH_OPTIONS = "POST /v1/auth/second-factor/fresh/passkey/options";
const FRESH_VERIFY = "POST /v1/auth/second-factor/fresh/passkey/verify";
const START = "POST /v1/auth/second-factor/totp/start";
const CONFIRM = "POST /v1/auth/second-factor/totp/confirm";
const REMOVE_APP = "POST /v1/auth/second-factor/totp/remove";
const REMOVE_PASSKEY = "POST /v1/auth/second-factor/passkeys/remove";
const NEW_CODES = "POST /v1/auth/second-factor/backup-codes";
const REGISTER_OPTIONS = "POST /v1/auth/passkey/register/options";
const REGISTER_VERIFY = "POST /v1/auth/passkey/register/verify";

// Every call the page makes, answered by the handler keyed "METHOD /path". An unknown route is a 404.
function installFetch(handlers: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const origin = [AUTH, API].find((candidate) => url.startsWith(candidate)) ?? "";
    const call: Call = {
      origin,
      path: url.slice(origin.length),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    const handler = handlers[`${call.method} ${call.path}`];
    return handler === undefined ? status(404) : handler(call);
  });
  return calls;
}

function sequence(calls: Call[]): string[] {
  return calls.map((call) => `${call.method} ${call.path}`);
}

function callsTo(calls: Call[], route: string): Call[] {
  return calls.filter((call) => `${call.method} ${call.path}` === route);
}

function b64u(...values: number[]): string {
  return Buffer.from(values).toString("base64url");
}

function buffer(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

type GetFn = (options?: CredentialRequestOptions) => Promise<unknown>;
type CreateFn = (options?: CredentialCreationOptions) => Promise<unknown>;

function stubWebAuthn(): { get: Mock<GetFn>; create: Mock<CreateFn> } {
  const get = vi.fn<GetFn>();
  const create = vi.fn<CreateFn>();
  vi.stubGlobal("PublicKeyCredential", class PublicKeyCredentialStandIn {});
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { get, create },
  });
  return { get, create };
}

function assertionResult(): unknown {
  return {
    id: "ignored",
    type: "public-key",
    rawId: buffer(1, 2, 3),
    response: {
      clientDataJSON: buffer(4, 5),
      authenticatorData: buffer(6, 7, 8),
      signature: buffer(9),
      userHandle: null,
    },
  };
}

function attestationResult(): unknown {
  return {
    id: "ignored",
    type: "public-key",
    rawId: buffer(1, 2, 3),
    response: { clientDataJSON: buffer(4, 5), attestationObject: buffer(6, 7, 8) },
  };
}

const ASSERTION_BODY = {
  credentialId: b64u(1, 2, 3),
  clientDataJSON: b64u(4, 5),
  authenticatorData: b64u(6, 7, 8),
  signature: b64u(9),
};

const ATTESTATION_BODY = {
  clientDataJSON: b64u(4, 5),
  attestationObject: b64u(6, 7, 8),
};

const CHALLENGE = [1, 1, 2, 3, 5, 8];

function authenticationOptions(): Response {
  return json({ challenge: b64u(...CHALLENGE), rpId: RP_ID, userVerification: "required" });
}

function registrationOptions(): Response {
  return json({
    challenge: b64u(...CHALLENGE),
    rp: { id: RP_ID, name: "Community Hub" },
    user: { id: b64u(7, 7, 7), name: "user", displayName: "user" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    attestation: "none",
    authenticatorSelection: { userVerification: "required", residentKey: "required" },
    excludeCredentials: [{ type: "public-key", id: b64u(5, 5) }],
  });
}

async function showSecurity(token: string | null = TOKEN): Promise<void> {
  if (token !== null) {
    sessionStorage.setItem(ACCESS_KEY, token);
    sessionStorage.setItem(HANDLE_KEY, token);
  }
  await router.navigate("/settings/security");
  view = render(<Shell />).container;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

async function press(name: string): Promise<void> {
  await click(await screen.findByRole("button", { name }));
}

// A person clicks a control that already has the focus, so that a dialog can give it back.
async function pressFocused(name: string): Promise<HTMLElement> {
  const button = await screen.findByRole("button", { name });
  button.focus();
  await click(button);
  return button;
}

async function type(label: string, value: string): Promise<void> {
  const input = await screen.findByRole("textbox", { name: label });
  fireEvent.change(input, { target: { value } });
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

// The list, as the page has to ask for it again after each change.
function listThatChanges(first: Record<string, unknown>) {
  const state = { body: first };
  const handler: Handler = () => json(state.body);
  return { state, handler };
}

let local: Storage;

beforeEach(async () => {
  local = createStorage();
  vi.stubGlobal("localStorage", local);
  sessionStorage.clear();
  await router.navigate("/");
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  delete document.documentElement.dataset.theme;
  Reflect.deleteProperty(navigator, "credentials");
  Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Settings → Security: the list", () => {
  it("lists the authenticator app, each passkey and the unused backup codes with their dates", async () => {
    stubWebAuthn();
    const calls = installFetch({
      [LIST]: () => json(listBody({ passkeys: [KEY_A, KEY_B], backupCodesLeft: 8 })),
    });
    await showSecurity();

    await screen.findByRole("heading", { name: "Authenticator app", level: 2 });
    expect(screen.getByRole("heading", { name: "Security", level: 1 })).toBeTruthy();
    expect(document.title).toBe("Security · Community Hub");
    expect(router.state.location.pathname).toBe("/settings/security");
    expect(screen.getByText(`Set up on ${dateOf(APP_AT)}.`)).toBeTruthy();

    expect(screen.getByRole("heading", { name: "Passkeys", level: 2 })).toBeTruthy();
    const passkeys = within(screen.getByRole("list", { name: "Your passkeys" })).getAllByRole(
      "listitem",
    );
    expect(passkeys).toHaveLength(2);
    expect(passkeys[0]?.textContent).toContain("Passkey 1");
    expect(passkeys[0]?.textContent).toContain(`Added ${dateOf(KEY_A.createdAt)}`);
    expect(passkeys[1]?.textContent).toContain("Passkey 2");
    expect(passkeys[1]?.textContent).toContain(`Added ${dateOf(KEY_B.createdAt)}`);

    expect(screen.getByRole("heading", { name: "Backup codes", level: 2 })).toBeTruthy();
    expect(screen.getByText("Unused backup codes: 8.")).toBeTruthy();
    // Nothing is wrong, so nothing warns.
    expect(screen.queryByText(/Make new ones/)).toBeNull();

    // One call, to the auth service, with the signed-in token. The token stays where it was.
    expect(sequence(calls)).toEqual([LIST]);
    expect(calls[0]?.origin).toBe(AUTH);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers.get("content-type")).toBeNull();
    expect(sessionStorage.getItem(ACCESS_KEY)).toBe(TOKEN);
    await expectNoAxeViolations();
  });

  it("says what is not set up", async () => {
    stubWebAuthn();
    installFetch({
      [LIST]: () => json(listBody({ totp: null, passkeys: [], backupCodesLeft: 10 })),
    });
    await showSecurity();

    await screen.findByRole("heading", { name: "Authenticator app", level: 2 });
    expect(screen.getByText("Not set up.")).toBeTruthy();
    expect(screen.getByText("No passkeys yet.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Your passkeys" })).toBeNull();
    expect(screen.getByRole("button", { name: "Set up an authenticator app" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a passkey" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make new backup codes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Replace authenticator app" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove authenticator app" })).toBeNull();
    await expectNoAxeViolations();
  });

  it("offers to replace or remove the authenticator app once it is set up", async () => {
    installFetch({ [LIST]: () => json(listBody()) });
    await showSecurity();

    await screen.findByRole("heading", { name: "Authenticator app", level: 2 });
    expect(screen.getByRole("button", { name: "Replace authenticator app" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove authenticator app" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up an authenticator app" })).toBeNull();
  });

  it("warns when two or fewer backup codes are left", async () => {
    const expected: [number, string][] = [
      [2, "You have 2 backup codes left. Make new ones."],
      [1, "You have 1 backup code left. Make new ones."],
      [0, "You have no backup codes left. Make new ones."],
    ];
    let left = 2;
    installFetch({ [LIST]: () => json(listBody({ backupCodesLeft: left })) });
    for (const [count, sentence] of expected) {
      left = count;
      await showSecurity();
      await screen.findByText(`Unused backup codes: ${count}.`);
      const warning = screen.getByText(sentence);
      expect(warning.closest('[data-slot="alert"]')).not.toBeNull();
      await expectNoAxeViolations();
      cleanup();
      sessionStorage.clear();
      await router.navigate("/");
    }

    left = 3;
    await showSecurity();
    await screen.findByText("Unused backup codes: 3.");
    expect(screen.queryByText(/Make new ones/)).toBeNull();
  });

  it("the Security page never shows a TOTP key, even when the answer carries one", async () => {
    stubWebAuthn();
    const spaced = groupsOfFour(LISTED_SECRET);
    installFetch({
      [LIST]: () =>
        json({
          ...listBody(),
          secret: LISTED_SECRET,
          otpauthUri: OTPAUTH,
          totp: { confirmedAt: APP_AT, secret: LISTED_SECRET, otpauthUri: OTPAUTH },
          passkeys: [{ ...KEY_A, secret: LISTED_SECRET }],
        }),
    });
    await showSecurity();

    await screen.findByText(`Set up on ${dateOf(APP_AT)}.`);
    const page = document.body.innerHTML.replace(/\s+/g, "");
    expect(page).not.toContain(LISTED_SECRET);
    expect(page).not.toContain(spaced.replace(/\s+/g, ""));
    expect(page).not.toContain("otpauth");
    expect(document.body.textContent).not.toContain(LISTED_SECRET);
    expect(document.body.textContent).not.toContain(spaced);
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.title).not.toContain(LISTED_SECRET);
    expect(window.location.href).not.toContain(LISTED_SECRET);
    for (const key of [ACCESS_KEY, HANDLE_KEY]) {
      expect(sessionStorage.getItem(key)).toBe(TOKEN);
    }
    expect(sessionStorage.length).toBe(2);
  });

  it("asks to sign in when there is no token, and calls nothing", async () => {
    const calls = installFetch({});
    await showSecurity(null);

    expect(await screen.findByRole("heading", { name: "Security", level: 1 })).toBeTruthy();
    expect(screen.getByText("Sign in required")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in");
    expect(calls).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: /authenticator app|passkey|backup codes/i }),
    ).toBeNull();
  });

  it("a signed-out answer clears the token and asks to sign in", async () => {
    const calls = installFetch({ [LIST]: () => status(401) });
    await showSecurity();

    expect(await screen.findByText("Sign in required")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in");
    expect(sessionStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(sequence(calls)).toEqual([LIST]);
    expect(screen.queryByRole("alert")).toBeNull();
    await expectNoAxeViolations();
  });

  it("a list that cannot be read says so and can be asked for again", async () => {
    let answers = 0;
    const calls = installFetch({
      [LIST]: () => {
        answers += 1;
        if (answers === 1) {
          throw new TypeError("network down");
        }
        return json(listBody());
      },
    });
    await showSecurity();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(MESSAGE.generic);
    expect(document.activeElement).toBe(alert);
    expect(screen.queryByRole("heading", { name: "Authenticator app" })).toBeNull();
    expect(sessionStorage.getItem(ACCESS_KEY)).toBe(TOKEN);
    await expectNoAxeViolations();

    await press("Try again");
    expect(
      await screen.findByRole("heading", { name: "Authenticator app", level: 2 }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(sequence(calls)).toEqual([LIST, LIST]);
  });

  it("an answer it cannot read says to try again and shows nothing of it", async () => {
    installFetch({ [LIST]: () => json({ totp: null, passkeys: [], freshUntil: null }) });
    await showSecurity();

    expect((await screen.findByRole("alert")).textContent).toBe(MESSAGE.generic);
    expect(screen.queryByRole("heading", { name: "Backup codes" })).toBeNull();
  });

  it("reads each answer strictly: a bad date or a bad count shows nothing", async () => {
    for (const body of [
      listBody({ totp: { confirmedAt: "not a date" } }),
      listBody({ passkeys: [{ id: "", createdAt: null }] }),
      listBody({ passkeys: [{ id: KEY_A.id, createdAt: "never" }] }),
      listBody({ backupCodesLeft: -1 }),
      listBody({ backupCodesLeft: 1.5 }),
      listBody({ freshUntil: "tomorrow" }),
      listBody({ recoveryUntil: 5 }),
    ]) {
      installFetch({ [LIST]: () => json(body) });
      await showSecurity();
      expect((await screen.findByRole("alert")).textContent).toBe(MESSAGE.generic);
      expect(screen.queryByRole("heading", { name: "Backup codes" })).toBeNull();
      cleanup();
      vi.restoreAllMocks();
      sessionStorage.clear();
      await router.navigate("/");
    }
  });

  it("shows a passkey with no date as added on an unknown date", async () => {
    stubWebAuthn();
    installFetch({
      [LIST]: () => json(listBody({ passkeys: [{ id: KEY_A.id, createdAt: null }] })),
    });
    await showSecurity();
    const item = (
      await within(await screen.findByRole("list", { name: "Your passkeys" })).findAllByRole(
        "listitem",
      )
    )[0];
    expect(item?.textContent).toContain("Added on an unknown date");
  });

  it("renders in StrictMode", async () => {
    stubWebAuthn();
    installFetch({ [LIST]: () => json(listBody()) });
    sessionStorage.setItem(ACCESS_KEY, TOKEN);
    await router.navigate("/settings/security");
    view = render(
      <StrictMode>
        <Shell />
      </StrictMode>,
    ).container;

    expect(
      await screen.findByRole("heading", { name: "Authenticator app", level: 2 }),
    ).toBeTruthy();
    expect(screen.getAllByRole("heading", { name: "Authenticator app" })).toHaveLength(1);
  });
});

describe("Settings → Security: confirming it's you", () => {
  it("asks to confirm it's you before a change, then goes on with the change", async () => {
    const calls = installFetch({
      [LIST]: () => json(listBody()),
      [FRESH]: () => status(204),
      [START]: () => json({ secret: SECRET, otpauthUri: OTPAUTH }),
    });
    await showSecurity();
    const trigger = await pressFocused("Replace authenticator app");

    const heading = await screen.findByRole("heading", { name: "Confirm it's you", level: 2 });
    expect(document.activeElement).toBe(heading);
    // Nothing is sent until the code is.
    expect(sequence(calls)).toEqual([LIST]);
    expect(screen.queryByRole("heading", { name: "Authenticator app" })).toBeNull();
    expect(trigger.isConnected).toBe(false);
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
    await expectNoAxeViolations();

    await type("Authenticator code", "12ab34");
    expect(
      (screen.getByRole("textbox", { name: "Authenticator code" }) as HTMLInputElement).value,
    ).toBe("1234");
    expect(confirm.disabled).toBe(true);
    await type("Authenticator code", TOTP_CODE);
    expect(confirm.disabled).toBe(false);
    await press("Confirm");

    expect(
      await screen.findByRole("heading", { name: "Set up an authenticator app" }),
    ).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, FRESH, START]);
    expect(callsTo(calls, FRESH)[0]?.body).toEqual({ code: TOTP_CODE });
    for (const call of calls) {
      expect(call.origin).toBe(AUTH);
      expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
    for (const call of calls.slice(1)) {
      expect(call.headers.get("content-type")).toBe("application/json");
    }
    expect(callsTo(calls, START)[0]?.body).toEqual({});
    expect(sessionStorage.getItem(ACCESS_KEY)).toBe(TOKEN);
  });

  it("does not ask while a fresh factor is current", async () => {
    const calls = installFetch({
      [LIST]: () => json(listBody({ freshUntil: inMinutes(4) })),
      [START]: () => json({ secret: SECRET, otpauthUri: OTPAUTH }),
    });
    await showSecurity();
    await press("Replace authenticator app");

    expect(
      await screen.findByRole("heading", { name: "Set up an authenticator app" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Confirm it's you" })).toBeNull();
    expect(sequence(calls)).toEqual([LIST, START]);
  });

  it("asks once the fresh factor the answer named has run out", async () => {
    const calls = installFetch({
      [LIST]: () => json(listBody({ freshUntil: inMinutes(-1) })),
    });
    await showSecurity();
    await press("Replace authenticator app");

    expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST]);
  });

  it("confirms and tries again when a change is refused although a fresh factor was current", async () => {
    let lists = 0;
    let starts = 0;
    const calls = installFetch({
      [LIST]: () => {
        lists += 1;
        return json(listBody({ freshUntil: lists === 1 ? inMinutes(4) : null }));
      },
      [FRESH]: () => status(204),
      [START]: () => {
        starts += 1;
        return starts === 1 ? status(401) : json({ secret: SECRET, otpauthUri: OTPAUTH });
      },
    });
    await showSecurity();
    await press("Replace authenticator app");

    const heading = await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(document.activeElement).toBe(heading);
    expect(sequence(calls)).toEqual([LIST, START, LIST]);
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");

    expect(
      await screen.findByRole("heading", { name: "Set up an authenticator app" }),
    ).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, START, LIST, FRESH, START]);
  });

  it("a wrong code says so and keeps asking", async () => {
    let answers = 0;
    const calls = installFetch({
      [LIST]: () => json(listBody()),
      [FRESH]: () => {
        answers += 1;
        return answers === 1 ? status(401) : status(204);
      },
      [START]: () => json({ secret: SECRET, otpauthUri: OTPAUTH }),
    });
    await showSecurity();
    await press("Replace authenticator app");
    await type("Authenticator code", "111111");
    await press("Confirm");

    const alert = await screen.findByText(MESSAGE.wrong);
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    expect(document.activeElement).toBe(alert.closest('[role="alert"]'));
    expect(
      (screen.getByRole("textbox", { name: "Authenticator code" }) as HTMLInputElement).value,
    ).toBe("");
    expect(screen.queryByRole("heading", { name: "Confirm it's you" })).not.toBeNull();
    // A wrong code asks the list whether the session is still there.
    expect(sequence(calls)).toEqual([LIST, FRESH, LIST]);
    expect(sessionStorage.getItem(ACCESS_KEY)).toBe(TOKEN);
    await expectNoAxeViolations();

    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");
    expect(
      await screen.findByRole("heading", { name: "Set up an authenticator app" }),
    ).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, FRESH, LIST, FRESH, START]);
    expect(screen.queryByText(MESSAGE.wrong)).toBeNull();
  });

  it("too many tries says to try later and keeps the session", async () => {
    const calls = installFetch({
      [LIST]: () => json(listBody()),
      [FRESH]: () => status(429),
    });
    await showSecurity();
    await press("Replace authenticator app");
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");

    const alert = await screen.findByText(MESSAGE.limited);
    expect(document.activeElement).toBe(alert.closest('[role="alert"]'));
    expect(screen.queryByRole("heading", { name: "Confirm it's you" })).not.toBeNull();
    expect(sequence(calls)).toEqual([LIST, FRESH]);
    expect(sessionStorage.getItem(ACCESS_KEY)).toBe(TOKEN);
    expect(sessionStorage.getItem(HANDLE_KEY)).toBe(TOKEN);
    await expectNoAxeViolations();
  });

  it("a check that fails says to try again", async () => {
    let answers = 0;
    installFetch({
      [LIST]: () => json(listBody()),
      [FRESH]: () => {
        answers += 1;
        if (answers === 1) {
          throw new TypeError("network down");
        }
        return status(500);
      },
    });
    await showSecurity();
    await press("Replace authenticator app");
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");
    await screen.findByText(MESSAGE.generic);
    expect(screen.queryByText(MESSAGE.wrong)).toBeNull();

    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");
    await waitFor(() => {
      expect(answers).toBe(2);
    });
    await screen.findByText(MESSAGE.generic);
    expect(screen.queryByRole("heading", { name: "Confirm it's you" })).not.toBeNull();
  });

  it("a refused check in a session that has ended asks to sign in", async () => {
    let lists = 0;
    const calls = installFetch({
      [LIST]: () => {
        lists += 1;
        return lists === 1 ? json(listBody()) : status(401);
      },
      [FRESH]: () => status(401),
    });
    await showSecurity();
    await press("Replace authenticator app");
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");

    expect(await screen.findByText("Sign in required")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in");
    expect(screen.queryByText(MESSAGE.wrong)).toBeNull();
    expect(sessionStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(sequence(calls)).toEqual([LIST, FRESH, LIST]);
  });

  it("a passkey confirms it's you", async () => {
    const { get } = stubWebAuthn();
    get.mockResolvedValue(assertionResult());
    const calls = installFetch({
      [LIST]: () => json(listBody()),
      [FRESH_OPTIONS]: () => authenticationOptions(),
      [FRESH_VERIFY]: () => status(204),
      [START]: () => json({ secret: SECRET, otpauthUri: OTPAUTH }),
    });
    await showSecurity();
    await press("Replace authenticator app");
    await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(screen.getByRole("textbox", { name: "Authenticator code" })).toBeTruthy();
    await expectNoAxeViolations();
    await press("Use a passkey");

    expect(
      await screen.findByRole("heading", { name: "Set up an authenticator app" }),
    ).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, FRESH_OPTIONS, FRESH_VERIFY, START]);
    expect(callsTo(calls, FRESH_OPTIONS)[0]?.body).toEqual({});
    expect(callsTo(calls, FRESH_VERIFY)[0]?.body).toEqual(ASSERTION_BODY);
    expect(get).toHaveBeenCalledTimes(1);
    const asked = get.mock.calls[0]?.[0]?.publicKey;
    expect(asked?.rpId).toBe(RP_ID);
    expect(asked?.userVerification).toBe("required");
    expect(Array.from(new Uint8Array(asked?.challenge as ArrayBuffer))).toEqual(CHALLENGE);
  });

  it("offers only the passkey to a person who has no authenticator app", async () => {
    const { get } = stubWebAuthn();
    get.mockResolvedValue(assertionResult());
    installFetch({
      [LIST]: () => json(listBody({ totp: null })),
      [FRESH_OPTIONS]: () => authenticationOptions(),
      [FRESH_VERIFY]: () => status(204),
      [START]: () => json({ secret: SECRET, otpauthUri: OTPAUTH }),
    });
    await showSecurity();
    await press("Set up an authenticator app");

    await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.getByRole("button", { name: "Use a passkey" })).toBeTruthy();
    await expectNoAxeViolations();
    await press("Use a passkey");
    expect(
      await screen.findByRole("heading", { name: "Set up an authenticator app" }),
    ).toBeTruthy();
  });

  it("says so when the only way to confirm is a passkey and this browser has none", async () => {
    const calls = installFetch({ [LIST]: () => json(listBody({ totp: null })) });
    await showSecurity();
    await press("Set up an authenticator app");

    await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(screen.getByText(MESSAGE.noPasskeyHere)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeNull();
    expect(sequence(calls)).toEqual([LIST]);
    await expectNoAxeViolations();
  });

  it("a passkey the browser does not give says to try again and sends nothing", async () => {
    const { get } = stubWebAuthn();
    get.mockRejectedValue(new DOMException("cancelled", "NotAllowedError"));
    const calls = installFetch({
      [LIST]: () => json(listBody()),
      [FRESH_OPTIONS]: () => authenticationOptions(),
    });
    await showSecurity();
    await press("Replace authenticator app");
    await press("Use a passkey");

    await screen.findByText(MESSAGE.generic);
    expect(callsTo(calls, FRESH_VERIFY)).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Confirm it's you" })).not.toBeNull();
  });

  it("a passkey that does not check out says so", async () => {
    const { get } = stubWebAuthn();
    get.mockResolvedValue(assertionResult());
    const calls = installFetch({
      [LIST]: () => json(listBody()),
      [FRESH_OPTIONS]: () => authenticationOptions(),
      [FRESH_VERIFY]: () => status(401),
    });
    await showSecurity();
    await press("Replace authenticator app");
    await press("Use a passkey");

    await screen.findByText(MESSAGE.wrong);
    expect(sequence(calls)).toEqual([LIST, FRESH_OPTIONS, FRESH_VERIFY, LIST]);
    expect(screen.queryByRole("heading", { name: "Confirm it's you" })).not.toBeNull();
  });

  it("too many passkey tries says to try later", async () => {
    const { get } = stubWebAuthn();
    get.mockResolvedValue(assertionResult());
    installFetch({
      [LIST]: () => json(listBody()),
      [FRESH_OPTIONS]: () => authenticationOptions(),
      [FRESH_VERIFY]: () => status(429),
    });
    await showSecurity();
    await press("Replace authenticator app");
    await press("Use a passkey");
    await screen.findByText(MESSAGE.limited);
  });

  it("stops offering passkeys when the service has none", async () => {
    const { get } = stubWebAuthn();
    const calls = installFetch({
      [LIST]: () => json(listBody()),
      [FRESH_OPTIONS]: () => status(404),
    });
    await showSecurity();
    await press("Replace authenticator app");
    await press("Use a passkey");

    await screen.findByText(MESSAGE.passkeysUnavailable);
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).not.toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(sequence(calls)).toEqual([LIST, FRESH_OPTIONS]);
  });

  it("Cancel returns to the list, sends nothing and gives the focus back to the button", async () => {
    const calls = installFetch({ [LIST]: () => json(listBody()) });
    await showSecurity();
    await pressFocused("Replace authenticator app");
    await screen.findByRole("heading", { name: "Confirm it's you" });
    await press("Cancel");

    const back = await screen.findByRole("button", { name: "Replace authenticator app" });
    expect(screen.queryByRole("heading", { name: "Confirm it's you" })).toBeNull();
    expect(document.activeElement).toBe(back);
    expect(sequence(calls)).toEqual([LIST]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an answer that arrives after Cancel changes nothing", async () => {
    const pending = deferred<Response>();
    const calls = installFetch({
      [LIST]: () => json(listBody()),
      [FRESH]: () => pending.promise,
      [START]: () => json({ secret: SECRET, otpauthUri: OTPAUTH }),
    });
    await showSecurity();
    await press("Replace authenticator app");
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");
    await waitFor(() => {
      expect(callsTo(calls, FRESH)).toHaveLength(1);
    });
    await press("Cancel");
    await screen.findByRole("button", { name: "Replace authenticator app" });

    await act(async () => {
      pending.resolve(status(204));
    });
    expect(sequence(calls)).toEqual([LIST, FRESH]);
    expect(screen.queryByRole("heading", { name: "Set up an authenticator app" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace authenticator app" })).not.toBeNull();
  });

  it("sends a code once while it waits for the answer", async () => {
    const pending = deferred<Response>();
    const calls = installFetch({
      [LIST]: () => json(listBody()),
      [FRESH]: () => pending.promise,
      [START]: () => json({ secret: SECRET, otpauthUri: OTPAUTH }),
    });
    await showSecurity();
    await press("Replace authenticator app");
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");
    await waitFor(() => {
      expect(callsTo(calls, FRESH)).toHaveLength(1);
    });

    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    const form = screen.getByRole("textbox", { name: "Authenticator code" }).closest("form");
    expect(form).not.toBeNull();
    await act(async () => {
      fireEvent.submit(form as HTMLFormElement);
    });
    expect(callsTo(calls, FRESH)).toHaveLength(1);

    await act(async () => {
      pending.resolve(status(204));
    });
    expect(
      await screen.findByRole("heading", { name: "Set up an authenticator app" }),
    ).toBeTruthy();
    expect(callsTo(calls, FRESH)).toHaveLength(1);
  });

  it("a second change inside the window does not ask again", async () => {
    const server = listThatChanges(listBody());
    const calls = installFetch({
      [LIST]: server.handler,
      [FRESH]: () => {
        // From now on the service reports the fresh factor it just accepted.
        server.state.body = listBody({ freshUntil: inMinutes(5) });
        return status(204);
      },
      [NEW_CODES]: () => json({ backupCodes: NEW_BACKUP_CODES }),
    });
    await showSecurity();
    await press("Make new backup codes");
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");
    await screen.findByRole("heading", { name: "Save your backup codes" });
    fireEvent.click(screen.getByRole("checkbox", { name: "I have saved these codes" }));
    await press("Continue");
    await screen.findByRole("heading", { name: "Authenticator app", level: 2 });

    await press("Make new backup codes");
    expect(await screen.findByRole("heading", { name: "Save your backup codes" })).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, FRESH, NEW_CODES, LIST, NEW_CODES]);
  });
});

describe("Settings → Security: the authenticator app", () => {
  it("sets up an app: the picture is inline SVG, the key is in groups of four and a code confirms it", async () => {
    const server = listThatChanges(listBody({ totp: null, freshUntil: inMinutes(4) }));
    const calls = installFetch({
      [LIST]: server.handler,
      [START]: () => json({ secret: SECRET, otpauthUri: OTPAUTH }),
      [CONFIRM]: () => {
        server.state.body = listBody({ freshUntil: inMinutes(4) });
        return status(204);
      },
    });
    await showSecurity();
    await pressFocused("Set up an authenticator app");

    const heading = await screen.findByRole("heading", { name: "Set up an authenticator app" });
    expect(document.activeElement).toBe(heading);
    const qr = await screen.findByRole("img", { name: "QR code for your authenticator app" });
    const svg = qr.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toMatch(/^0 0 \d+ \d+$/);
    expect(svg?.querySelectorAll("path").length).toBeGreaterThan(0);
    // The page's security policy allows no data: images and no style attributes or elements.
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain("data:");
    expect(qr.querySelector("style")).toBeNull();
    expect(qr.innerHTML).not.toContain("style=");
    // The picture is the sign-in screen's picture for the same link.
    const expected = document.createElement("div");
    expected.innerHTML = await qrToString(OTPAUTH, { type: "svg" });
    expect(qr.innerHTML).toBe(expected.innerHTML);
    expect(screen.getByText(groupsOfFour(SECRET))).toBeTruthy();
    expect(groupsOfFour(SECRET).split(" ")).toHaveLength(8);
    expect(document.body.textContent).not.toContain(OTPAUTH);
    expect(window.location.href).not.toContain(SECRET);
    expect(document.title).not.toContain(SECRET);
    await expectNoAxeViolations();

    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");

    expect(await screen.findByText("Authenticator app set up.")).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, START, CONFIRM, LIST]);
    expect(callsTo(calls, CONFIRM)[0]?.body).toEqual({ code: TOTP_CODE });
    // The key and the picture are gone, and the list shows the new state.
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.body.textContent).not.toContain(groupsOfFour(SECRET));
    expect(screen.queryByText("Not set up.")).toBeNull();
    expect(screen.getByText(`Set up on ${dateOf(APP_AT)}.`)).toBeTruthy();
    const replace = screen.getByRole("button", { name: "Replace authenticator app" });
    expect(document.activeElement).toBe(replace);
    const statusRegion = screen.getByText("Authenticator app set up.").closest('[role="status"]');
    expect(statusRegion).not.toBeNull();
    await expectNoAxeViolations();
  });

  it("replaces an app that is set up in the same way", async () => {
    const server = listThatChanges(listBody({ freshUntil: inMinutes(4) }));
    const calls = installFetch({
      [LIST]: server.handler,
      [START]: () => json({ secret: SECRET, otpauthUri: OTPAUTH }),
      [CONFIRM]: () => {
        server.state.body = listBody({
          totp: { confirmedAt: "2026-09-10T11:12:13.000Z" },
          freshUntil: inMinutes(4),
        });
        return status(204);
      },
    });
    await showSecurity();
    await screen.findByText(`Set up on ${dateOf(APP_AT)}.`);
    await press("Replace authenticator app");
    await screen.findByRole("heading", { name: "Set up an authenticator app" });
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");

    await screen.findByText("Authenticator app set up.");
    expect(screen.getByText(`Set up on ${dateOf("2026-09-10T11:12:13.000Z")}.`)).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, START, CONFIRM, LIST]);
  });

  it("a wrong code says to check the time and keeps the picture", async () => {
    let answers = 0;
    const calls = installFetch({
      [LIST]: () => json(listBody({ freshUntil: inMinutes(4) })),
      [START]: () => json({ secret: SECRET, otpauthUri: OTPAUTH }),
      [CONFIRM]: () => {
        answers += 1;
        return answers === 1 ? status(401) : status(204);
      },
    });
    await showSecurity();
    await press("Replace authenticator app");
    await screen.findByRole("img", { name: "QR code for your authenticator app" });
    await type("Authenticator code", "111111");
    await press("Confirm");

    const alert = await screen.findByText(MESSAGE.wrongSetupCode);
    expect(document.activeElement).toBe(alert.closest('[role="alert"]'));
    expect(
      screen.queryByRole("img", { name: "QR code for your authenticator app" }),
    ).not.toBeNull();
    expect(screen.queryByText(groupsOfFour(SECRET))).not.toBeNull();
    expect(sequence(calls)).toEqual([LIST, START, CONFIRM, LIST]);
    await expectNoAxeViolations();

    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");
    await screen.findByText("Authenticator app set up.");
    expect(callsTo(calls, CONFIRM)).toHaveLength(2);
  });

  it("asks to confirm it's you again when the fresh factor ran out during the setup", async () => {
    let lists = 0;
    let starts = 0;
    const calls = installFetch({
      [LIST]: () => {
        lists += 1;
        return json(listBody({ freshUntil: lists === 1 ? inMinutes(4) : null }));
      },
      [START]: () => {
        starts += 1;
        return json({ secret: SECRET, otpauthUri: OTPAUTH });
      },
      [CONFIRM]: () => status(401),
      [FRESH]: () => status(204),
    });
    await showSecurity();
    await press("Replace authenticator app");
    await screen.findByRole("img", { name: "QR code for your authenticator app" });
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");

    const heading = await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(document.activeElement).toBe(heading);
    expect(screen.queryByRole("img")).toBeNull();
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");
    await screen.findByRole("heading", { name: "Set up an authenticator app" });
    expect(starts).toBe(2);
    expect(sequence(calls)).toEqual([LIST, START, CONFIRM, LIST, FRESH, START]);
  });

  it("Cancel leaves nothing set up and gives the focus back to the button", async () => {
    const calls = installFetch({
      [LIST]: () => json(listBody({ totp: null, freshUntil: inMinutes(4) })),
      [START]: () => json({ secret: SECRET, otpauthUri: OTPAUTH }),
    });
    await showSecurity();
    await pressFocused("Set up an authenticator app");
    await screen.findByRole("img", { name: "QR code for your authenticator app" });
    await press("Cancel");

    const back = await screen.findByRole("button", { name: "Set up an authenticator app" });
    expect(document.activeElement).toBe(back);
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.body.textContent).not.toContain(groupsOfFour(SECRET));
    expect(sequence(calls)).toEqual([LIST, START]);
    expect(screen.getByText("Not set up.")).toBeTruthy();
  });

  it("a start that fails says so and shows no picture", async () => {
    const calls = installFetch({
      [LIST]: () => json(listBody({ freshUntil: inMinutes(4) })),
      [START]: () => status(500),
    });
    await showSecurity();
    await press("Replace authenticator app");

    const alert = await screen.findByText(MESSAGE.generic);
    expect(document.activeElement).toBe(alert.closest('[role="alert"]'));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace authenticator app" })).not.toBeNull();
    expect(sequence(calls)).toEqual([LIST, START]);
  });

  it("an answer with no key says so and shows no picture", async () => {
    installFetch({
      [LIST]: () => json(listBody({ freshUntil: inMinutes(4) })),
      [START]: () => json({ otpauthUri: OTPAUTH }),
    });
    await showSecurity();
    await press("Replace authenticator app");
    await screen.findByText(MESSAGE.generic);
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.body.textContent).not.toContain("otpauth");
  });

  it("a session that has ended asks to sign in instead of showing a picture", async () => {
    let lists = 0;
    installFetch({
      [LIST]: () => {
        lists += 1;
        return lists === 1 ? json(listBody({ freshUntil: inMinutes(4) })) : status(401);
      },
      [START]: () => status(401),
    });
    await showSecurity();
    await press("Replace authenticator app");

    expect(await screen.findByText("Sign in required")).toBeTruthy();
    expect(sessionStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("Settings → Security: passkeys", () => {
  it("adds a passkey", async () => {
    const { create } = stubWebAuthn();
    create.mockResolvedValue(attestationResult());
    const server = listThatChanges(listBody({ freshUntil: inMinutes(4) }));
    const calls = installFetch({
      [LIST]: server.handler,
      [REGISTER_OPTIONS]: () => registrationOptions(),
      [REGISTER_VERIFY]: () => {
        server.state.body = listBody({ passkeys: [KEY_A, KEY_B], freshUntil: inMinutes(4) });
        return status(204);
      },
    });
    await showSecurity();
    await pressFocused("Add a passkey");

    expect(await screen.findByText("Passkey added.")).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, REGISTER_OPTIONS, REGISTER_VERIFY, LIST]);
    expect(callsTo(calls, REGISTER_OPTIONS)[0]?.body).toEqual({});
    expect(callsTo(calls, REGISTER_VERIFY)[0]?.body).toEqual(ATTESTATION_BODY);
    expect(create).toHaveBeenCalledTimes(1);
    const made = create.mock.calls[0]?.[0]?.publicKey;
    expect(made?.rp.id).toBe(RP_ID);
    expect(made?.authenticatorSelection?.userVerification).toBe("required");
    expect(made?.authenticatorSelection?.residentKey).toBe("required");
    expect(made?.attestation).toBe("none");
    expect(Array.from(new Uint8Array(made?.challenge as ArrayBuffer))).toEqual(CHALLENGE);
    expect(
      (made?.excludeCredentials ?? []).map((entry) =>
        Array.from(new Uint8Array(entry.id as ArrayBuffer)),
      ),
    ).toEqual([[5, 5]]);
    const items = within(screen.getByRole("list", { name: "Your passkeys" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a passkey" }));
    expect(screen.getByRole("button", { name: "Add a passkey" })).toBeTruthy();
    await expectNoAxeViolations();
  });

  it("asks to confirm it's you before adding a passkey", async () => {
    const { create } = stubWebAuthn();
    create.mockResolvedValue(attestationResult());
    const calls = installFetch({
      [LIST]: () => json(listBody()),
      [FRESH]: () => status(204),
      [REGISTER_OPTIONS]: () => registrationOptions(),
      [REGISTER_VERIFY]: () => status(204),
    });
    await showSecurity();
    await press("Add a passkey");
    await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(create).not.toHaveBeenCalled();
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");

    expect(await screen.findByText("Passkey added.")).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, FRESH, REGISTER_OPTIONS, REGISTER_VERIFY, LIST]);
  });

  it("a passkey the browser does not give says it was not saved and sends nothing", async () => {
    const { create } = stubWebAuthn();
    create.mockRejectedValue(new DOMException("cancelled", "NotAllowedError"));
    const calls = installFetch({
      [LIST]: () => json(listBody({ freshUntil: inMinutes(4) })),
      [REGISTER_OPTIONS]: () => registrationOptions(),
    });
    await showSecurity();
    await press("Add a passkey");

    const alert = await screen.findByText(MESSAGE.passkeyNotSaved);
    expect(document.activeElement).toBe(alert.closest('[role="alert"]'));
    expect(callsTo(calls, REGISTER_VERIFY)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Add a passkey" })).not.toBeNull();
    expect(screen.queryByText("Passkey added.")).toBeNull();
  });

  it("a passkey the service refuses says it was not saved", async () => {
    const { create } = stubWebAuthn();
    create.mockResolvedValue(attestationResult());
    const calls = installFetch({
      [LIST]: () => json(listBody({ freshUntil: inMinutes(4) })),
      [REGISTER_OPTIONS]: () => registrationOptions(),
      [REGISTER_VERIFY]: () => status(401),
    });
    await showSecurity();
    await press("Add a passkey");

    await screen.findByText(MESSAGE.passkeyNotSaved);
    expect(sequence(calls)).toEqual([LIST, REGISTER_OPTIONS, REGISTER_VERIFY, LIST]);
  });

  it("stops offering passkeys when the service has none", async () => {
    stubWebAuthn();
    const calls = installFetch({
      [LIST]: () => json(listBody({ passkeys: [], freshUntil: inMinutes(4) })),
      [REGISTER_OPTIONS]: () => status(404),
    });
    await showSecurity();
    await press("Add a passkey");

    expect(await screen.findByText(MESSAGE.passkeysUnavailable)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Passkeys" })).toBeNull();
    expect(sequence(calls)).toEqual([LIST, REGISTER_OPTIONS]);
    // The button that was pressed is gone, so the heading takes the focus.
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Security", level: 1 }),
      );
    });
    await expectNoAxeViolations();
  });

  it("hides the passkey controls when the browser has no WebAuthn", async () => {
    installFetch({ [LIST]: () => json(listBody({ passkeys: [] })) });
    await showSecurity();

    await screen.findByRole("heading", { name: "Authenticator app", level: 2 });
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Passkeys" })).toBeNull();
    expect(screen.queryByText("No passkeys yet.")).toBeNull();
    await expectNoAxeViolations();
  });

  it("still lists and removes passkeys the browser could not have added", async () => {
    installFetch({ [LIST]: () => json(listBody({ freshUntil: inMinutes(4) })) });
    await showSecurity();

    await screen.findByRole("heading", { name: "Passkeys", level: 2 });
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove passkey 1" })).toBeTruthy();
  });

  it("does not offer a passkey to confirm with when the browser has no WebAuthn", async () => {
    installFetch({ [LIST]: () => json(listBody()) });
    await showSecurity();
    await press("Replace authenticator app");
    await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).not.toBeNull();
  });
});

describe("Settings → Security: removing a factor", () => {
  it("asks to confirm before removing a factor", async () => {
    stubWebAuthn();
    const server = listThatChanges(
      listBody({ passkeys: [KEY_A, KEY_B], freshUntil: inMinutes(4) }),
    );
    const calls = installFetch({
      [LIST]: server.handler,
      [REMOVE_APP]: () => status(204),
      [REMOVE_PASSKEY]: () => status(204),
    });
    await showSecurity();

    // The app: the question comes first, and nothing is sent while it is open.
    const removeApp = await pressFocused("Remove authenticator app");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeNull();
    });
    expect(sequence(calls)).toEqual([LIST]);
    const appDialog = await screen.findByRole("dialog", { name: "Remove your authenticator app?" });
    // The dialog takes the focus when it opens, and gives it back to the button when it closes.
    await waitFor(() => {
      expect(appDialog.contains(document.activeElement)).toBe(true);
    });
    expect(within(appDialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    await expectNoAxeViolationsInBody();
    fireEvent.click(within(appDialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(removeApp);
    });
    expect(sequence(calls)).toEqual([LIST]);

    // A passkey: the same.
    const removeKey = await pressFocused("Remove passkey 2");
    const keyDialog = await screen.findByRole("dialog", { name: "Remove this passkey?" });
    expect(sequence(calls)).toEqual([LIST]);
    fireEvent.keyDown(keyDialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(removeKey);
    });
    expect(sequence(calls)).toEqual([LIST]);

    // Only the answer to the question sends the request, once.
    await pressFocused("Remove authenticator app");
    const again = await screen.findByRole("dialog", { name: "Remove your authenticator app?" });
    server.state.body = listBody({
      totp: null,
      passkeys: [KEY_A, KEY_B],
      freshUntil: inMinutes(4),
    });
    fireEvent.click(within(again).getByRole("button", { name: "Remove" }));
    await screen.findByText("Authenticator app removed.");
    expect(sequence(calls)).toEqual([LIST, REMOVE_APP, LIST]);
    expect(callsTo(calls, REMOVE_APP)[0]?.body).toEqual({});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("removes a passkey by its id, after the question", async () => {
    stubWebAuthn();
    const server = listThatChanges(
      listBody({ passkeys: [KEY_A, KEY_B], freshUntil: inMinutes(4) }),
    );
    const calls = installFetch({
      [LIST]: server.handler,
      [REMOVE_PASSKEY]: () => {
        server.state.body = listBody({ passkeys: [KEY_A], freshUntil: inMinutes(4) });
        return status(204);
      },
    });
    await showSecurity();
    await pressFocused("Remove passkey 2");
    const dialog = await screen.findByRole("dialog", { name: "Remove this passkey?" });
    expect(
      within(dialog).getByText(
        "You will no longer be able to use this passkey to confirm it's you.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("Passkey removed.")).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, REMOVE_PASSKEY, LIST]);
    expect(callsTo(calls, REMOVE_PASSKEY)[0]?.body).toEqual({ passkeyId: KEY_B.id });
    expect(
      within(screen.getByRole("list", { name: "Your passkeys" })).getAllByRole("listitem"),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Remove passkey 2" })).toBeNull();
    // The button that was pressed is gone, so the heading takes the focus.
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Security", level: 1 }),
      );
    });
    await expectNoAxeViolations();
  });

  it("asks to confirm it's you after the question when there is no fresh factor", async () => {
    const calls = installFetch({
      [LIST]: () => json(listBody()),
      [FRESH]: () => status(204),
      [REMOVE_PASSKEY]: () => status(204),
    });
    await showSecurity();
    await pressFocused("Remove passkey 1");
    const dialog = await screen.findByRole("dialog", { name: "Remove this passkey?" });
    expect(sequence(calls)).toEqual([LIST]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    const heading = await screen.findByRole("heading", { name: "Confirm it's you" });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sequence(calls)).toEqual([LIST]);
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");

    expect(await screen.findByText("Passkey removed.")).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, FRESH, REMOVE_PASSKEY, LIST]);
    expect(callsTo(calls, REMOVE_PASSKEY)[0]?.body).toEqual({ passkeyId: KEY_A.id });
  });

  it("the last factor says so and changes nothing", async () => {
    const calls = installFetch({
      [LIST]: () => json(listBody({ freshUntil: inMinutes(4) })),
      [REMOVE_APP]: () => status(409),
      [REMOVE_PASSKEY]: () => status(409),
    });
    await showSecurity();

    await pressFocused("Remove authenticator app");
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    let alert = await screen.findByText(MESSAGE.lastFactor);
    expect(document.activeElement).toBe(alert.closest('[role="alert"]'));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByText(`Set up on ${dateOf(APP_AT)}.`)).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, REMOVE_APP]);
    await expectNoAxeViolations();

    await pressFocused("Remove passkey 1");
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(callsTo(calls, REMOVE_PASSKEY)).toHaveLength(1);
    });
    alert = await screen.findByText(MESSAGE.lastFactor);
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Remove passkey 1" })).not.toBeNull();
    expect(sequence(calls)).toEqual([LIST, REMOVE_APP, REMOVE_PASSKEY]);
  });

  it("a passkey that is no longer there says so and reloads the list", async () => {
    stubWebAuthn();
    const server = listThatChanges(
      listBody({ passkeys: [KEY_A, KEY_B], freshUntil: inMinutes(4) }),
    );
    const calls = installFetch({
      [LIST]: server.handler,
      [REMOVE_PASSKEY]: () => {
        server.state.body = listBody({ passkeys: [KEY_A], freshUntil: inMinutes(4) });
        return status(404);
      },
    });
    await showSecurity();
    await pressFocused("Remove passkey 2");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    const alert = await screen.findByText(MESSAGE.passkeyGone);
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    expect(sequence(calls)).toEqual([LIST, REMOVE_PASSKEY, LIST]);
    expect(
      within(screen.getByRole("list", { name: "Your passkeys" })).getAllByRole("listitem"),
    ).toHaveLength(1);
    expect(screen.queryByText("Passkey removed.")).toBeNull();
  });

  it("an app that is no longer there says so and reloads the list", async () => {
    const server = listThatChanges(listBody({ freshUntil: inMinutes(4) }));
    const calls = installFetch({
      [LIST]: server.handler,
      [REMOVE_APP]: () => {
        server.state.body = listBody({ totp: null, freshUntil: inMinutes(4) });
        return status(404);
      },
    });
    await showSecurity();
    await pressFocused("Remove authenticator app");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await screen.findByText(MESSAGE.appGone);
    expect(sequence(calls)).toEqual([LIST, REMOVE_APP, LIST]);
    expect(screen.getByText("Not set up.")).toBeTruthy();
  });

  it("a removal that fails says to try again and leaves the list as it was", async () => {
    const calls = installFetch({
      [LIST]: () => json(listBody({ freshUntil: inMinutes(4) })),
      [REMOVE_PASSKEY]: () => {
        throw new TypeError("network down");
      },
    });
    await showSecurity();
    await pressFocused("Remove passkey 1");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await screen.findByText(MESSAGE.generic);
    expect(sequence(calls)).toEqual([LIST, REMOVE_PASSKEY]);
    expect(screen.queryByRole("button", { name: "Remove passkey 1" })).not.toBeNull();
  });

  it("a removal refused for a lapsed fresh factor asks to confirm it's you and goes on", async () => {
    let lists = 0;
    let removals = 0;
    const calls = installFetch({
      [LIST]: () => {
        lists += 1;
        return json(listBody({ freshUntil: lists === 1 ? inMinutes(4) : null }));
      },
      [FRESH]: () => status(204),
      [REMOVE_PASSKEY]: () => {
        removals += 1;
        return removals === 1 ? status(401) : status(204);
      },
    });
    await showSecurity();
    await pressFocused("Remove passkey 1");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await screen.findByRole("heading", { name: "Confirm it's you" });
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");

    expect(await screen.findByText("Passkey removed.")).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, REMOVE_PASSKEY, LIST, FRESH, REMOVE_PASSKEY, LIST]);
  });
});

describe("Settings → Security: backup codes", () => {
  it("makes new backup codes and shows them once", async () => {
    const server = listThatChanges(listBody({ backupCodesLeft: 1, freshUntil: inMinutes(4) }));
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const calls = installFetch({
      [LIST]: server.handler,
      [NEW_CODES]: () => {
        server.state.body = listBody({ backupCodesLeft: 10, freshUntil: inMinutes(4) });
        return json({ backupCodes: NEW_BACKUP_CODES });
      },
    });
    await showSecurity();
    await screen.findByText("You have 1 backup code left. Make new ones.");
    await pressFocused("Make new backup codes");

    const heading = await screen.findByRole("heading", { name: "Save your backup codes" });
    expect(document.activeElement).toBe(heading);
    expect(
      screen.getByText(
        "Keep these somewhere safe. They are the only way back in if you lose your phone or passkey.",
      ),
    ).toBeTruthy();
    for (const code of NEW_BACKUP_CODES) {
      expect(screen.getByText(groupsOfFour(code))).toBeTruthy();
    }
    expect(callsTo(calls, NEW_CODES)[0]?.body).toEqual({});
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await expectNoAxeViolations();

    await press("Copy");
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(writeText).toHaveBeenCalledWith(NEW_BACKUP_CODES.map(groupsOfFour).join("\n"));
    expect(await screen.findByText("Copied")).toBeTruthy();

    // The list does not come back until the codes are saved.
    const next = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.click(next);
    expect(screen.queryByRole("heading", { name: "Save your backup codes" })).not.toBeNull();
    expect(sequence(calls)).toEqual([LIST, NEW_CODES]);
    fireEvent.click(screen.getByRole("checkbox", { name: "I have saved these codes" }));
    await press("Continue");

    expect(await screen.findByText("New backup codes made.")).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, NEW_CODES, LIST]);
    expect(screen.getByText("Unused backup codes: 10.")).toBeTruthy();
    expect(screen.queryByText(/Make new ones/)).toBeNull();
    // Shown once: nothing of them is left on the page.
    for (const code of NEW_BACKUP_CODES) {
      expect(document.body.textContent).not.toContain(groupsOfFour(code));
      expect(document.body.textContent).not.toContain(code);
    }
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Make new backup codes" }),
    );
    await expectNoAxeViolations();
  });

  it("asks to confirm it's you before making new backup codes", async () => {
    const calls = installFetch({
      [LIST]: () => json(listBody()),
      [FRESH]: () => status(204),
      [NEW_CODES]: () => json({ backupCodes: NEW_BACKUP_CODES }),
    });
    await showSecurity();
    await press("Make new backup codes");
    await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(callsTo(calls, NEW_CODES)).toHaveLength(0);
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");

    expect(await screen.findByRole("heading", { name: "Save your backup codes" })).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, FRESH, NEW_CODES]);
  });

  it("codes that cannot be read are not shown and the old ones are not replaced on screen", async () => {
    installFetch({
      [LIST]: () => json(listBody({ freshUntil: inMinutes(4) })),
      [NEW_CODES]: () => json({ backupCodes: [] }),
    });
    await showSecurity();
    await press("Make new backup codes");
    await screen.findByText(MESSAGE.generic);
    expect(screen.queryByRole("heading", { name: "Save your backup codes" })).toBeNull();
  });

  it("new codes that fail say to try again", async () => {
    installFetch({
      [LIST]: () => json(listBody({ freshUntil: inMinutes(4) })),
      [NEW_CODES]: () => status(500),
    });
    await showSecurity();
    await press("Make new backup codes");
    await screen.findByText(MESSAGE.generic);
    expect(screen.queryByRole("heading", { name: "Save your backup codes" })).toBeNull();
  });

  it("writes no code, key, link or token to the console, the address, the title or storage", async () => {
    const writes = captureConsole();
    const sessionWrites = vi.spyOn(Object.getPrototypeOf(window.sessionStorage), "setItem");
    const server = listThatChanges(listBody({ totp: null, freshUntil: inMinutes(4) }));
    installFetch({
      [LIST]: server.handler,
      [START]: () => json({ secret: SECRET, otpauthUri: OTPAUTH }),
      [CONFIRM]: () => {
        server.state.body = listBody({ freshUntil: inMinutes(4) });
        return status(204);
      },
      [NEW_CODES]: () => json({ backupCodes: NEW_BACKUP_CODES }),
    });
    await showSecurity();
    await press("Set up an authenticator app");
    await screen.findByRole("heading", { name: "Set up an authenticator app" });
    expect(document.title).not.toContain(SECRET);
    expect(window.location.href).not.toContain(SECRET);
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");
    await screen.findByText("Authenticator app set up.");
    await press("Make new backup codes");
    await screen.findByRole("heading", { name: "Save your backup codes" });
    for (const code of NEW_BACKUP_CODES) {
      expect(document.title).not.toContain(code);
      expect(window.location.href).not.toContain(code);
    }
    fireEvent.click(screen.getByRole("checkbox", { name: "I have saved these codes" }));
    await press("Continue");
    await screen.findByText("New backup codes made.");

    const dumped = writes.join("\n");
    for (const secret of [TOKEN, SECRET, OTPAUTH, TOTP_CODE, ...NEW_BACKUP_CODES]) {
      expect(dumped).not.toContain(secret);
    }
    const stored = sessionWrites.mock.calls.map((args) =>
      args.map((value) => String(value)).join(" "),
    );
    for (const secret of [SECRET, OTPAUTH, TOTP_CODE, ...NEW_BACKUP_CODES]) {
      expect(stored.join("\n")).not.toContain(secret);
    }
    expect(local.length).toBe(0);
    expect(sessionStorage.length).toBe(2);
    expect(sessionStorage.getItem(ACCESS_KEY)).toBe(TOKEN);
  });
});

describe("Settings → Security: a backup-code recovery window", () => {
  it("a recovery session offers no app removal", async () => {
    stubWebAuthn();
    const calls = installFetch({
      [LIST]: () =>
        json(listBody({ passkeys: [KEY_A, KEY_B], freshUntil: null, recoveryUntil: inMinutes(9) })),
    });
    await showSecurity();

    await screen.findByRole("heading", { name: "Authenticator app", level: 2 });
    expect(screen.getByText(MESSAGE.recovery)).toBeTruthy();
    // The app may be replaced, never removed.
    expect(screen.getByRole("button", { name: "Replace authenticator app" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove authenticator app" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove authenticator/ })).toBeNull();
    // The rest of what the window allows is there.
    expect(screen.getByRole("button", { name: "Add a passkey" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove passkey 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove passkey 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make new backup codes" })).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST]);
    await expectNoAxeViolations();
  });

  it("a recovery session with no app offers to set one up, and still no removal", async () => {
    installFetch({
      [LIST]: () => json(listBody({ totp: null, recoveryUntil: inMinutes(9) })),
    });
    await showSecurity();
    await screen.findByText(MESSAGE.recovery);
    expect(screen.getByRole("button", { name: "Set up an authenticator app" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove authenticator app" })).toBeNull();
  });

  it("a session that is not in a window does not say it is", async () => {
    installFetch({ [LIST]: () => json(listBody({ freshUntil: inMinutes(4) })) });
    await showSecurity();
    await screen.findByRole("heading", { name: "Authenticator app", level: 2 });
    expect(screen.queryByText(MESSAGE.recovery)).toBeNull();
    expect(screen.getByRole("button", { name: "Remove authenticator app" })).toBeTruthy();
  });

  it("replaces the app inside the window without asking to confirm it's you", async () => {
    const server = listThatChanges(listBody({ recoveryUntil: inMinutes(9) }));
    const calls = installFetch({
      [LIST]: server.handler,
      [START]: () => json({ secret: SECRET, otpauthUri: OTPAUTH }),
      [CONFIRM]: () => status(204),
    });
    await showSecurity();
    await press("Replace authenticator app");
    await screen.findByRole("img", { name: "QR code for your authenticator app" });
    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");

    await screen.findByText("Authenticator app set up.");
    expect(sequence(calls)).toEqual([LIST, START, CONFIRM, LIST]);
    expect(screen.queryByRole("heading", { name: "Confirm it's you" })).toBeNull();
    expect(screen.getByText(MESSAGE.recovery)).toBeTruthy();
  });

  it("adds and removes a passkey inside the window without asking to confirm it's you", async () => {
    const { create } = stubWebAuthn();
    create.mockResolvedValue(attestationResult());
    const server = listThatChanges(listBody({ recoveryUntil: inMinutes(9) }));
    const calls = installFetch({
      [LIST]: server.handler,
      [REGISTER_OPTIONS]: () => registrationOptions(),
      [REGISTER_VERIFY]: () => status(204),
      [REMOVE_PASSKEY]: () => status(204),
    });
    await showSecurity();
    await press("Add a passkey");
    await screen.findByText("Passkey added.");
    expect(sequence(calls)).toEqual([LIST, REGISTER_OPTIONS, REGISTER_VERIFY, LIST]);

    await pressFocused("Remove passkey 1");
    const dialog = await screen.findByRole("dialog", { name: "Remove this passkey?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await screen.findByText("Passkey removed.");
    expect(sequence(calls)).toEqual([
      LIST,
      REGISTER_OPTIONS,
      REGISTER_VERIFY,
      LIST,
      REMOVE_PASSKEY,
      LIST,
    ]);
    expect(screen.queryByRole("heading", { name: "Confirm it's you" })).toBeNull();
  });

  it("makes new backup codes inside the window without asking to confirm it's you", async () => {
    const calls = installFetch({
      [LIST]: () => json(listBody({ recoveryUntil: inMinutes(9), backupCodesLeft: 1 })),
      [NEW_CODES]: () => json({ backupCodes: NEW_BACKUP_CODES }),
    });
    await showSecurity();
    await press("Make new backup codes");

    expect(await screen.findByRole("heading", { name: "Save your backup codes" })).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, NEW_CODES]);
    expect(callsTo(calls, FRESH)).toHaveLength(0);
  });

  it("says the window has ended, and offers no change, once the service refuses one", async () => {
    let lists = 0;
    const calls = installFetch({
      [LIST]: () => {
        lists += 1;
        return json(listBody({ recoveryUntil: lists === 1 ? inMinutes(1) : null }));
      },
      [START]: () => status(401),
    });
    await showSecurity();
    await press("Replace authenticator app");

    const notice = await screen.findByText(MESSAGE.windowEnded);
    expect(notice.closest('[data-slot="alert"]')).not.toBeNull();
    expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe(
      "/sign-in",
    );
    // A session that signed in with a backup code can never confirm it's you, so it is not asked to.
    expect(screen.queryByRole("heading", { name: "Confirm it's you" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace authenticator app" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make new backup codes" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(screen.queryByText(MESSAGE.recovery)).toBeNull();
    // What it knows is still shown.
    expect(screen.getByText(`Set up on ${dateOf(APP_AT)}.`)).toBeTruthy();
    expect(sequence(calls)).toEqual([LIST, START, LIST]);
    await expectNoAxeViolations();
  });
});

describe("Settings → Security: the navigation", () => {
  it("reaches the page from the Settings link", async () => {
    installFetch({ [LIST]: () => json(listBody()) });
    sessionStorage.setItem(ACCESS_KEY, TOKEN);
    await router.navigate("/");
    view = render(<Shell />).container;

    const nav = screen.getByRole("navigation", { name: "Admin" });
    const link = within(nav).getByRole("link", { name: "Security" });
    expect(link.getAttribute("href")).toBe("/settings/security");
    await click(link);
    expect(
      await screen.findByRole("heading", { name: "Authenticator app", level: 2 }),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe("/settings/security");
    expect(within(nav).getByRole("link", { name: "Security" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });
});
