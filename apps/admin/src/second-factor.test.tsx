import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { toString as qrToString } from "qrcode";
import { afterEach, beforeEach, type Mock } from "vitest";

import { clearInviteToken, getInviteToken, setInviteToken } from "./invite-token";
import { router, Shell } from "./shell";

// Everything below is synthetic. Tokens, the TOTP key and the backup codes are built at run time,
// so no key-shaped or code-shaped literal is committed.
const INVITE = "v1." + "A".repeat(107);
const EMAIL = "ada@example.test";
const EMAIL_CODE = "12345678";
const PRE_TOKEN = "pre-token-" + "1";
const PRE_TOKEN_TWO = "pre-token-" + "2";
const ADMIN_TOKEN = "admin-token-" + "1";
const REFRESH = "refresh-" + "1";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const TOTP_CODE = "654321";
const AUTH = "https://auth.au.example.test";
const API = "https://au.api.example.test";
const RP_ID = "admin.example.test";
const ACCESS_KEY = "community-hub.access-token";
const HANDLE_KEY = "community-hub.signout-handle";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BACKUP_CODES = Array.from({ length: 10 }, (_, index) => BASE32.slice(index, index + 12));

const SENTENCE = {
  wrong: "That code didn't work.",
  tooMany: "Too many tries. Sign in again.",
  generic: "Something went wrong. Try again.",
  wrongSetupCode: "That code didn't work. Check the time on your phone and try again.",
  passkeyNotSaved: "The passkey wasn't saved. Try again or use an authenticator app.",
  lost: "Lost your phone and all your backup codes? You can't sign in until your account is recovered. Contact Community Hub support.",
  keepSafe:
    "Keep these somewhere safe. They are the only way back in if you lose your phone or passkey.",
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

const SECRET = base32(Uint8Array.from({ length: 20 }, (_, index) => (index * 13 + 7) % 256));
const OTPAUTH =
  "otpauth://totp/Community%20Hub?secret=" +
  SECRET +
  "&issuer=Community%20Hub&algorithm=SHA1&digits=6&period=30";
const SECRET_GROUPS = (SECRET.match(/.{4}/g) ?? []).join(" ");

function resultIds(
  results: axe.AxeResults,
  bucket: "passes" | "violations" | "incomplete" | "inapplicable",
): string[] {
  return results[bucket].map((entry) => entry.id);
}

// The container testing-library renders into, which is the context every admin axe test uses. It
// holds the whole sign-in card. A run over the whole body also reports `region` on the card's
// heading and fields, because the page layout around them has no landmark; that is the layout's,
// not these screens'.
let view: HTMLElement | undefined;

async function expectNoAxeViolations(): Promise<void> {
  if (view === undefined) {
    throw new Error("nothing is rendered");
  }
  const results = await axe.run(view, { rules: { "color-contrast": { enabled: false } } });
  expect(resultIds(results, "violations")).toEqual([]);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Call = {
  path: string;
  method: string | undefined;
  headers: Headers;
  body: unknown;
};

type Handler = (call: Call) => Response | Promise<Response>;

function installFetch(handlers: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const origin = [AUTH, API].find((candidate) => url.startsWith(candidate));
    const path = origin === undefined ? url : url.slice(origin.length);
    const call: Call = {
      path,
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    const handler = handlers[path];
    return handler === undefined ? new Response(null, { status: 404 }) : handler(call);
  });
  return calls;
}

function callsTo(calls: Call[], path: string): Call[] {
  return calls.filter((call) => call.path === path);
}

// What the sign-in screens sent. Once signed in, the admin pages make their own API calls.
function authCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.path.startsWith("/v1/auth/"));
}

function sentAuthorization(call: Call | undefined): string | null | undefined {
  return call?.headers.get("authorization");
}

const START: Record<string, Handler> = {
  "/v1/auth/email-otp/start": () => new Response(null, { status: 204 }),
};

function verifyAnswer(
  over: Partial<{
    secondFactor: "verify" | "setup";
    methods: string[];
    passkeysAvailable: boolean;
    accessToken: string;
  }> = {},
): Response {
  return json({
    secondFactor: "verify",
    methods: ["totp"],
    passkeysAvailable: false,
    accessToken: PRE_TOKEN,
    expiresIn: 900,
    ...over,
  });
}

function adminAnswer(extra: Record<string, unknown> = {}): Response {
  return json({
    userId: USER_ID,
    accessToken: ADMIN_TOKEN,
    refreshToken: REFRESH,
    expiresIn: 900,
    ...extra,
  });
}

function setupHandlers(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    ...START,
    "/v1/auth/email-otp/verify": () => verifyAnswer({ secondFactor: "setup" }),
    "/v1/auth/second-factor/totp/start": () => json({ secret: SECRET, otpauthUri: OTPAUTH }),
    "/v1/auth/second-factor/totp/confirm": () => adminAnswer({ backupCodes: BACKUP_CODES }),
    ...over,
  };
}

function secondStepHandlers(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    ...START,
    "/v1/auth/email-otp/verify": () => verifyAnswer(),
    "/v1/auth/second-factor/verify": () => adminAnswer(),
    "/v1/auth/session/end": () => new Response(null, { status: 204 }),
    ...over,
  };
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

const ASSERTION_BODY = {
  credentialId: b64u(1, 2, 3),
  clientDataJSON: b64u(4, 5),
  authenticatorData: b64u(6, 7, 8),
  signature: b64u(9),
};

const CHALLENGE = [1, 1, 2, 3, 5, 8];

function authenticationOptions(): Response {
  return json({ challenge: b64u(...CHALLENGE), rpId: RP_ID, userVerification: "required" });
}

function registrationOptions(): Response {
  return json({
    challenge: b64u(...CHALLENGE),
    rp: { id: RP_ID, name: "Community Hub" },
    user: { id: b64u(7, 7, 7), name: USER_ID, displayName: USER_ID },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    attestation: "none",
    authenticatorSelection: { userVerification: "required", residentKey: "required" },
    excludeCredentials: [{ type: "public-key", id: b64u(5, 5) }],
  });
}

async function showSignIn(): Promise<void> {
  await router.navigate("/sign-in");
  view = render(<Shell />).container;
}

async function press(name: string): Promise<void> {
  const button = await screen.findByRole("button", { name });
  await act(async () => {
    fireEvent.click(button);
  });
}

async function type(label: string, value: string): Promise<void> {
  const input = await screen.findByRole("textbox", { name: label });
  fireEvent.change(input, { target: { value } });
}

// Email step, then the verify answer: the second step or the setup screen follows.
async function emailStep(): Promise<void> {
  await showSignIn();
  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: EMAIL } });
  await press("Send code");
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), {
    target: { value: EMAIL_CODE },
  });
  await press("Verify");
}

async function secondStepWithCode(code: string = TOTP_CODE): Promise<void> {
  await type("Authenticator code", code);
  await press("Confirm");
}

async function toQrScreen(): Promise<void> {
  await emailStep();
  await press("Use an authenticator app");
  await screen.findByRole("heading", { name: "Set up an authenticator app" });
}

async function toCodesScreen(): Promise<void> {
  await toQrScreen();
  await type("Authenticator code", TOTP_CODE);
  await press("Confirm");
  await screen.findByRole("heading", { name: "Save your backup codes" });
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

let local: Storage;

beforeEach(async () => {
  local = createStorage();
  vi.stubGlobal("localStorage", local);
  sessionStorage.clear();
  clearInviteToken();
  await router.navigate("/");
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  clearInviteToken();
  Reflect.deleteProperty(navigator, "credentials");
  Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the second step", () => {
  it("the second step offers only the methods in the verify answer", async () => {
    stubWebAuthn();
    let answer = verifyAnswer({ methods: ["totp"], passkeysAvailable: true });
    installFetch(secondStepHandlers({ "/v1/auth/email-otp/verify": () => answer }));

    await emailStep();
    await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use a backup code" })).toBeNull();
    cleanup();

    answer = verifyAnswer({ methods: ["passkey", "backup_code"], passkeysAvailable: true });
    await emailStep();
    await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use a passkey" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Use a backup code" })).not.toBeNull();
    cleanup();

    answer = verifyAnswer({ methods: ["totp", "backup_code"], passkeysAvailable: true });
    await emailStep();
    await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use a backup code" })).not.toBeNull();
  });

  it("does not offer a passkey the browser cannot use", async () => {
    installFetch(
      secondStepHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({ methods: ["totp", "passkey"], passkeysAvailable: true }),
      }),
    );
    await emailStep();
    await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).not.toBeNull();
  });

  it("does not offer a passkey the service reports as unavailable", async () => {
    stubWebAuthn();
    installFetch(
      secondStepHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({ methods: ["totp", "passkey"], passkeysAvailable: false }),
      }),
    );
    await emailStep();
    await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
  });

  it("says so when the only way offered is a passkey and this browser has none", async () => {
    installFetch(
      secondStepHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({ methods: ["passkey"], passkeysAvailable: true }),
      }),
    );
    await emailStep();
    await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(
      screen.queryByText("This browser can't use passkeys. Try another browser or device."),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeNull();
    await expectNoAxeViolations();
  });

  it("opens on the passkey when that is the first way offered, and passes axe", async () => {
    stubWebAuthn();
    installFetch(
      secondStepHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({ methods: ["passkey", "backup_code"], passkeysAvailable: true }),
      }),
    );
    await emailStep();
    const heading = await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(document.activeElement).toBe(heading);
    expect(screen.queryByRole("button", { name: "Use a passkey" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    await expectNoAxeViolations();

    await press("Use a backup code");
    const input = await screen.findByRole("textbox", { name: "Backup code" });
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("button", { name: "Use a passkey" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Use a backup code" })).toBeNull();
  });

  it("says what to do after losing the phone and every backup code", async () => {
    installFetch(secondStepHandlers());
    await emailStep();
    await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(screen.queryByText(SENTENCE.lost)).not.toBeNull();
  });

  it("moves focus to the heading and passes axe in each mode", async () => {
    stubWebAuthn();
    installFetch(
      secondStepHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({ methods: ["totp", "passkey", "backup_code"], passkeysAvailable: true }),
        "/v1/auth/second-factor/verify": () => new Response(null, { status: 401 }),
      }),
    );
    await emailStep();
    const heading = await screen.findByRole("heading", { name: "Confirm it's you" });
    expect(document.activeElement).toBe(heading);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    await expectNoAxeViolations();

    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");
    await waitFor(() => {
      expect(screen.queryByText(SENTENCE.wrong)).not.toBeNull();
    });
    const alert = screen.getByRole("alert");
    expect(document.activeElement).toBe(alert);
    await expectNoAxeViolations();

    await press("Use a backup code");
    await screen.findByRole("textbox", { name: "Backup code" });
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).toBeNull();
    await expectNoAxeViolations();
  });

  it("a user without an invitation lands on /settings/users", async () => {
    const calls = installFetch(secondStepHandlers());
    await emailStep();
    await secondStepWithCode();

    expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/settings/users");
    expect(getInviteToken()).toBeUndefined();
    expect(sessionStorage.getItem(ACCESS_KEY)).toBe(ADMIN_TOKEN);
    expect(sessionStorage.getItem(HANDLE_KEY)).toBe(ADMIN_TOKEN);
    expect(sessionStorage.length).toBe(2);
    const verify = callsTo(calls, "/v1/auth/second-factor/verify");
    expect(verify).toHaveLength(1);
    expect(verify[0]?.method).toBe("POST");
    expect(verify[0]?.body).toEqual({ method: "totp", code: TOTP_CODE });
    expect(sentAuthorization(verify[0])).toBe(`Bearer ${PRE_TOKEN}`);
    expect(verify[0]?.headers.get("content-type")).toBe("application/json");
  });

  it("an invited user lands on the accept screen", async () => {
    const calls = installFetch(secondStepHandlers());
    setInviteToken(INVITE);
    await emailStep();
    await secondStepWithCode();

    expect(await screen.findByRole("button", { name: "Accept invitation" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
    expect(screen.queryByRole("heading", { name: "Users & Roles" })).toBeNull();
    expect(getInviteToken()).toBe(INVITE);
    expect(sessionStorage.getItem(ACCESS_KEY)).toBe(ADMIN_TOKEN);
    expect(callsTo(calls, "/v1/invitations/accept")).toHaveLength(0);
  });

  it("a wrong code says so, keeps the session and lets the next code through", async () => {
    let answers = 0;
    const calls = installFetch(
      secondStepHandlers({
        "/v1/auth/second-factor/verify": () => {
          answers += 1;
          return answers === 1 ? new Response(null, { status: 401 }) : adminAnswer();
        },
      }),
    );
    await emailStep();
    await secondStepWithCode("111111");

    await screen.findByText(SENTENCE.wrong);
    expect(screen.getByRole("alert").textContent).toBe(SENTENCE.wrong);
    expect(sessionStorage.length).toBe(0);
    expect(router.state.location.pathname).toBe("/sign-in");
    const input = screen.getByRole("textbox", { name: "Authenticator code" });
    expect((input as HTMLInputElement).value).toBe("");

    await secondStepWithCode(TOTP_CODE);
    expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeTruthy();
    const verify = callsTo(calls, "/v1/auth/second-factor/verify");
    expect(verify).toHaveLength(2);
    expect(verify[1]?.body).toEqual({ method: "totp", code: TOTP_CODE });
    expect(sentAuthorization(verify[1])).toBe(`Bearer ${PRE_TOKEN}`);
    expect(authCalls(calls)).toHaveLength(4);
  });

  it("too many tries goes back to the email step and drops the pre-2FA token", async () => {
    let verifies = 0;
    const calls = installFetch(
      secondStepHandlers({
        "/v1/auth/email-otp/verify": () => {
          verifies += 1;
          return verifyAnswer({ accessToken: verifies === 1 ? PRE_TOKEN : PRE_TOKEN_TWO });
        },
        "/v1/auth/second-factor/verify": () => new Response(null, { status: 429 }),
      }),
    );
    await emailStep();
    await secondStepWithCode();

    await screen.findByText(SENTENCE.tooMany);
    expect(screen.getByRole("alert").textContent).toBe(SENTENCE.tooMany);
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Verify" })).not.toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(callsTo(calls, "/v1/auth/session/end")).toHaveLength(0);
    expect(authCalls(calls)).toHaveLength(3);
    await expectNoAxeViolations();

    fireEvent.change(screen.getByRole("textbox", { name: "Code" }), {
      target: { value: EMAIL_CODE },
    });
    await press("Verify");
    await secondStepWithCode();
    await waitFor(() => {
      expect(callsTo(calls, "/v1/auth/second-factor/verify")).toHaveLength(2);
    });
    expect(sentAuthorization(callsTo(calls, "/v1/auth/second-factor/verify")[1])).toBe(
      `Bearer ${PRE_TOKEN_TWO}`,
    );
  });

  it("the fifth wrong answer ends the sign-in", async () => {
    const calls = installFetch(
      secondStepHandlers({
        "/v1/auth/second-factor/verify": () => new Response(null, { status: 401 }),
      }),
    );
    await emailStep();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await secondStepWithCode("111111");
      await waitFor(() => {
        expect(callsTo(calls, "/v1/auth/second-factor/verify")).toHaveLength(attempt);
      });
      await screen.findByText(SENTENCE.wrong);
      expect(screen.queryByRole("textbox", { name: "Authenticator code" })).not.toBeNull();
    }
    await secondStepWithCode("111111");

    await screen.findByText(SENTENCE.tooMany);
    expect(callsTo(calls, "/v1/auth/second-factor/verify")).toHaveLength(5);
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("wrong passkey answers count toward the same five", async () => {
    const { get } = stubWebAuthn();
    get.mockResolvedValue(assertionResult());
    const calls = installFetch(
      secondStepHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({ methods: ["passkey"], passkeysAvailable: true }),
        "/v1/auth/second-factor/passkey/options": () => authenticationOptions(),
        "/v1/auth/second-factor/passkey/verify": () => new Response(null, { status: 401 }),
      }),
    );
    await emailStep();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await press("Use a passkey");
      await screen.findByText(SENTENCE.wrong);
      expect(callsTo(calls, "/v1/auth/second-factor/passkey/verify")).toHaveLength(attempt);
    }
    await press("Use a passkey");

    await screen.findByText(SENTENCE.tooMany);
    expect(callsTo(calls, "/v1/auth/second-factor/passkey/verify")).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps the pre-2FA session after a network failure", async () => {
    let answers = 0;
    const calls = installFetch(
      secondStepHandlers({
        "/v1/auth/second-factor/verify": () => {
          answers += 1;
          if (answers === 1) {
            throw new TypeError("network down");
          }
          return adminAnswer();
        },
      }),
    );
    await emailStep();
    await secondStepWithCode();

    await screen.findByText(SENTENCE.generic);
    expect(screen.getByRole("alert").textContent).toBe(SENTENCE.generic);
    expect(sessionStorage.length).toBe(0);

    await secondStepWithCode();
    expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeTruthy();
    const verify = callsTo(calls, "/v1/auth/second-factor/verify");
    expect(verify).toHaveLength(2);
    expect(sentAuthorization(verify[0])).toBe(`Bearer ${PRE_TOKEN}`);
    expect(sentAuthorization(verify[1])).toBe(`Bearer ${PRE_TOKEN}`);
  });

  it("a server error says to try again and does not count as a wrong code", async () => {
    installFetch(
      secondStepHandlers({
        "/v1/auth/second-factor/verify": () => new Response(null, { status: 500 }),
      }),
    );
    await emailStep();
    await secondStepWithCode();
    await screen.findByText(SENTENCE.generic);
    expect(screen.queryByText(SENTENCE.wrong)).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).not.toBeNull();
  });

  it("an answer with no token says to try again and signs nobody in", async () => {
    installFetch(
      secondStepHandlers({
        "/v1/auth/second-factor/verify": () => json({ userId: USER_ID, expiresIn: 900 }),
      }),
    );
    await emailStep();
    await secondStepWithCode();

    await screen.findByText(SENTENCE.generic);
    expect(sessionStorage.length).toBe(0);
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).not.toBeNull();
  });

  it("sends a code once while it waits for the answer", async () => {
    const pending = deferred<Response>();
    const calls = installFetch(
      secondStepHandlers({ "/v1/auth/second-factor/verify": () => pending.promise }),
    );
    await emailStep();
    await secondStepWithCode();
    await waitFor(() => {
      expect(callsTo(calls, "/v1/auth/second-factor/verify")).toHaveLength(1);
    });

    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Pressing Enter in the field submits the form again, and that is ignored too.
    const form = screen.getByRole("textbox", { name: "Authenticator code" }).closest("form");
    expect(form).not.toBeNull();
    await act(async () => {
      fireEvent.submit(form as HTMLFormElement);
    });
    expect(callsTo(calls, "/v1/auth/second-factor/verify")).toHaveLength(1);

    await act(async () => {
      pending.resolve(adminAnswer());
    });
    expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeTruthy();
    expect(callsTo(calls, "/v1/auth/second-factor/verify")).toHaveLength(1);
  });

  it("an answer that arrives after Cancel signs nobody in", async () => {
    const pending = deferred<Response>();
    const calls = installFetch(
      secondStepHandlers({ "/v1/auth/second-factor/verify": () => pending.promise }),
    );
    await emailStep();
    await secondStepWithCode();
    await waitFor(() => {
      expect(callsTo(calls, "/v1/auth/second-factor/verify")).toHaveLength(1);
    });
    await press("Cancel");
    expect(await screen.findByRole("textbox", { name: "Email" })).toBeTruthy();

    await act(async () => {
      pending.resolve(adminAnswer());
    });
    expect(sessionStorage.length).toBe(0);
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeNull();
    expect(callsTo(calls, "/v1/auth/session/end")).toHaveLength(1);
  });

  it("stores the admin token only after the second step", async () => {
    const pending = deferred<Response>();
    installFetch(secondStepHandlers({ "/v1/auth/second-factor/verify": () => pending.promise }));
    const sessionWrites = vi.spyOn(Object.getPrototypeOf(window.sessionStorage), "setItem");
    await emailStep();
    await screen.findByRole("heading", { name: "Confirm it's you" });

    expect(sessionStorage.length).toBe(0);
    expect(sessionStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(sessionWrites).not.toHaveBeenCalled();

    await secondStepWithCode();
    await waitFor(() => {
      expect(sessionStorage.length).toBe(0);
    });
    expect(sessionWrites).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(ACCESS_KEY)).toBeNull();

    await act(async () => {
      pending.resolve(adminAnswer());
    });
    expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeTruthy();
    expect(sessionStorage.getItem(ACCESS_KEY)).toBe(ADMIN_TOKEN);
    expect(sessionStorage.getItem(HANDLE_KEY)).toBe(ADMIN_TOKEN);
    expect(sessionStorage.length).toBe(2);
    for (const args of sessionWrites.mock.calls) {
      expect(args.map((value) => String(value))).not.toContain(PRE_TOKEN);
      expect(args.map((value) => String(value))).not.toContain(REFRESH);
    }
  });

  it("Cancel ends the pre-2FA session on the server", async () => {
    const calls = installFetch(secondStepHandlers());
    await emailStep();
    await screen.findByRole("heading", { name: "Confirm it's you" });

    await press("Cancel");

    expect(await screen.findByRole("textbox", { name: "Email" })).toBeTruthy();
    const ended = callsTo(calls, "/v1/auth/session/end");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.method).toBe("POST");
    expect(sentAuthorization(ended[0])).toBe(`Bearer ${PRE_TOKEN}`);
    expect(ended[0]?.body).toEqual({});
    expect(ended[0]?.headers.get("content-type")).toBe("application/json");
    expect(authCalls(calls)).toHaveLength(3);
    expect(screen.queryByRole("textbox", { name: "Authenticator code" })).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  it("Cancel goes back to the email step even when ending the session fails", async () => {
    const calls = installFetch(
      secondStepHandlers({
        "/v1/auth/session/end": () => {
          throw new TypeError("network down");
        },
      }),
    );
    await emailStep();
    await screen.findByRole("heading", { name: "Confirm it's you" });
    await press("Cancel");

    expect(await screen.findByRole("textbox", { name: "Email" })).toBeTruthy();
    expect(callsTo(calls, "/v1/auth/session/end")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("normalises a backup code in the input", async () => {
    const calls = installFetch(
      secondStepHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({ methods: ["totp", "backup_code"], passkeysAvailable: false }),
        "/v1/auth/second-factor/verify": () => adminAnswer({ backupCodesLeft: 7 }),
      }),
    );
    await emailStep();
    await press("Use a backup code");
    const input = await screen.findByRole("textbox", { name: "Backup code" });
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "abcd-efgh ijk" } });
    expect((input as HTMLInputElement).value).toBe("ABCD EFGH IJK");
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "abcd-efgh ijkl0189" } });
    expect((input as HTMLInputElement).value).toBe("ABCD EFGH IJKL");
    expect(confirm.disabled).toBe(false);

    await press("Confirm");
    await screen.findByRole("heading", { name: "You used a backup code" });
    const verify = callsTo(calls, "/v1/auth/second-factor/verify");
    expect(verify).toHaveLength(1);
    expect(verify[0]?.body).toEqual({ method: "backup_code", code: "ABCDEFGHIJKL" });
    expect(sentAuthorization(verify[0])).toBe(`Bearer ${PRE_TOKEN}`);
  });

  it("a backup code sign-in shows how many codes are left before it continues", async () => {
    let left = 7;
    installFetch(
      secondStepHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({ methods: ["backup_code"], passkeysAvailable: false }),
        "/v1/auth/second-factor/verify": () => adminAnswer({ backupCodesLeft: left }),
      }),
    );
    const expected: Record<number, string> = {
      7: "You have 7 backup codes left.",
      1: "You have 1 backup code left.",
      0: "You have no backup codes left.",
    };
    for (const count of [7, 1, 0]) {
      left = count;
      await emailStep();
      // Only a backup code is offered, so its field is the default.
      await type("Backup code", "abcdefghijkl");
      await press("Confirm");
      const heading = await screen.findByRole("heading", { name: "You used a backup code" });
      expect(document.activeElement).toBe(heading);
      expect(screen.queryByText(expected[count] ?? "")).not.toBeNull();
      expect(sessionStorage.length).toBe(0);
      await expectNoAxeViolations();
      if (count === 7) {
        await press("Continue");
        expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeTruthy();
        expect(sessionStorage.getItem(ACCESS_KEY)).toBe(ADMIN_TOKEN);
        expect(sessionStorage.getItem(HANDLE_KEY)).toBe(ADMIN_TOKEN);
        expect(sessionStorage.length).toBe(2);
      }
      cleanup();
      sessionStorage.clear();
      await router.navigate("/");
    }
  });

  it("signs in with a passkey as the second step", async () => {
    const { get } = stubWebAuthn();
    get.mockResolvedValue(assertionResult());
    const calls = installFetch(
      secondStepHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({ methods: ["passkey"], passkeysAvailable: true }),
        "/v1/auth/second-factor/passkey/options": () => authenticationOptions(),
        "/v1/auth/second-factor/passkey/verify": () => adminAnswer(),
      }),
    );
    await emailStep();
    await press("Use a passkey");

    expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeTruthy();
    const options = callsTo(calls, "/v1/auth/second-factor/passkey/options");
    expect(options).toHaveLength(1);
    expect(options[0]?.body).toEqual({});
    expect(sentAuthorization(options[0])).toBe(`Bearer ${PRE_TOKEN}`);
    expect(get).toHaveBeenCalledTimes(1);
    const asked = get.mock.calls[0]?.[0]?.publicKey;
    expect(asked?.rpId).toBe(RP_ID);
    expect(asked?.userVerification).toBe("required");
    expect(Array.from(new Uint8Array(asked?.challenge as ArrayBuffer))).toEqual(CHALLENGE);
    const verify = callsTo(calls, "/v1/auth/second-factor/passkey/verify");
    expect(verify).toHaveLength(1);
    expect(verify[0]?.body).toEqual(ASSERTION_BODY);
    expect(sentAuthorization(verify[0])).toBe(`Bearer ${PRE_TOKEN}`);
    expect(sessionStorage.getItem(ACCESS_KEY)).toBe(ADMIN_TOKEN);
    expect(sessionStorage.length).toBe(2);
  });

  it("a passkey the browser does not give says to try again and keeps the session", async () => {
    const { get } = stubWebAuthn();
    get.mockRejectedValue(new DOMException("cancelled", "NotAllowedError"));
    const calls = installFetch(
      secondStepHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({ methods: ["passkey"], passkeysAvailable: true }),
        "/v1/auth/second-factor/passkey/options": () => authenticationOptions(),
      }),
    );
    await emailStep();
    await press("Use a passkey");

    await screen.findByText(SENTENCE.generic);
    expect(callsTo(calls, "/v1/auth/second-factor/passkey/verify")).toHaveLength(0);
    expect(sessionStorage.length).toBe(0);
    expect(screen.queryByRole("button", { name: "Use a passkey" })).not.toBeNull();
  });

  it("a passkey of another user gives the same wrong-code answer", async () => {
    const { get } = stubWebAuthn();
    get.mockResolvedValue(assertionResult());
    installFetch(
      secondStepHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({ methods: ["passkey"], passkeysAvailable: true }),
        "/v1/auth/second-factor/passkey/options": () => authenticationOptions(),
        "/v1/auth/second-factor/passkey/verify": () => new Response(null, { status: 401 }),
      }),
    );
    await emailStep();
    await press("Use a passkey");
    await screen.findByText(SENTENCE.wrong);
    expect(sessionStorage.length).toBe(0);
  });
});

describe("setting up two-step sign-in", () => {
  it("offers only the authenticator app when the service has no passkeys", async () => {
    stubWebAuthn();
    installFetch(setupHandlers());
    await emailStep();

    const heading = await screen.findByRole("heading", { name: "Set up two-step sign-in" });
    expect(document.activeElement).toBe(heading);
    expect(screen.queryByRole("button", { name: "Use an authenticator app" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
    await expectNoAxeViolations();
  });

  it("offers only the authenticator app when the browser has no WebAuthn", async () => {
    installFetch(
      setupHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({
            secondFactor: "setup",
            methods: ["totp", "passkey"],
            passkeysAvailable: true,
          }),
      }),
    );
    await emailStep();

    await screen.findByRole("heading", { name: "Set up two-step sign-in" });
    expect(screen.queryByRole("button", { name: "Use an authenticator app" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
  });

  it("offers the authenticator app and a passkey when both can be used", async () => {
    stubWebAuthn();
    installFetch(
      setupHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({
            secondFactor: "setup",
            methods: ["totp", "passkey"],
            passkeysAvailable: true,
          }),
      }),
    );
    await emailStep();

    await screen.findByRole("heading", { name: "Set up two-step sign-in" });
    expect(screen.queryByRole("button", { name: "Use an authenticator app" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Use a passkey" })).not.toBeNull();
    await expectNoAxeViolations();
  });

  it("draws the QR as inline SVG", async () => {
    const calls = installFetch(setupHandlers());
    await toQrScreen();

    const heading = screen.getByRole("heading", { name: "Set up an authenticator app" });
    expect(document.activeElement).toBe(heading);
    const qr = await screen.findByRole("img", { name: "QR code for your authenticator app" });
    const svg = qr.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toMatch(/^0 0 \d+ \d+$/);
    expect(svg?.querySelectorAll("path").length).toBeGreaterThan(0);
    for (const path of Array.from(svg?.querySelectorAll("path") ?? [])) {
      expect(path.getAttribute("d")).toBeTruthy();
    }
    // The CSP allows no data: images and no style attributes or elements.
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain("data:");
    expect(qr.querySelector("style")).toBeNull();
    expect(qr.innerHTML).not.toContain("style=");
    // The picture is the library's SVG for this otpauth link.
    const expected = document.createElement("div");
    expected.innerHTML = await qrToString(OTPAUTH, { type: "svg" });
    expect(qr.innerHTML).toBe(expected.innerHTML);

    const start = callsTo(calls, "/v1/auth/second-factor/totp/start");
    expect(start).toHaveLength(1);
    expect(start[0]?.body).toEqual({});
    expect(sentAuthorization(start[0])).toBe(`Bearer ${PRE_TOKEN}`);
    await expectNoAxeViolations();
  });

  it("shows the key in groups of four and never in the address", async () => {
    installFetch(setupHandlers());
    await toQrScreen();

    expect(screen.queryByText(SECRET_GROUPS)).not.toBeNull();
    expect(SECRET_GROUPS.split(" ")).toHaveLength(8);
    expect(window.location.href).not.toContain(SECRET);
    expect(document.title).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain(OTPAUTH);
  });

  it("a wrong confirm code says to check the time and keeps the picture", async () => {
    let answers = 0;
    const calls = installFetch(
      setupHandlers({
        "/v1/auth/second-factor/totp/confirm": () => {
          answers += 1;
          return answers === 1
            ? new Response(null, { status: 401 })
            : adminAnswer({ backupCodes: BACKUP_CODES });
        },
      }),
    );
    await toQrScreen();
    await type("Authenticator code", "111111");
    await press("Confirm");

    await screen.findByText(SENTENCE.wrongSetupCode);
    expect(screen.getByRole("alert").textContent).toBe(SENTENCE.wrongSetupCode);
    expect(
      screen.queryByRole("img", { name: "QR code for your authenticator app" }),
    ).not.toBeNull();
    expect(screen.queryByText(SECRET_GROUPS)).not.toBeNull();
    expect(sessionStorage.length).toBe(0);
    await expectNoAxeViolations();

    await type("Authenticator code", TOTP_CODE);
    await press("Confirm");
    await screen.findByRole("heading", { name: "Save your backup codes" });
    const confirm = callsTo(calls, "/v1/auth/second-factor/totp/confirm");
    expect(confirm).toHaveLength(2);
    expect(confirm[1]?.body).toEqual({ code: TOTP_CODE });
    expect(sentAuthorization(confirm[1])).toBe(`Bearer ${PRE_TOKEN}`);
  });

  it("a start that fails says to try again and starts nothing", async () => {
    installFetch(
      setupHandlers({
        "/v1/auth/second-factor/totp/start": () => new Response(null, { status: 500 }),
      }),
    );
    await emailStep();
    await press("Use an authenticator app");
    await screen.findByText(SENTENCE.generic);
    expect(screen.queryByRole("heading", { name: "Set up two-step sign-in" })).not.toBeNull();
    expect(screen.queryByRole("img", { name: "QR code for your authenticator app" })).toBeNull();
  });

  it("Back from the picture returns to the choices", async () => {
    installFetch(setupHandlers());
    await toQrScreen();
    await press("Back");
    const heading = await screen.findByRole("heading", { name: "Set up two-step sign-in" });
    expect(document.activeElement).toBe(heading);
    expect(screen.queryByRole("img", { name: "QR code for your authenticator app" })).toBeNull();
    expect(screen.queryByText(SECRET_GROUPS)).toBeNull();
  });

  it("Cancel on the setup screens ends the pre-2FA session", async () => {
    const calls = installFetch(
      setupHandlers({ "/v1/auth/session/end": () => new Response(null, { status: 204 }) }),
    );
    await toQrScreen();
    await press("Cancel");

    expect(await screen.findByRole("textbox", { name: "Email" })).toBeTruthy();
    const ended = callsTo(calls, "/v1/auth/session/end");
    expect(ended).toHaveLength(1);
    expect(sentAuthorization(ended[0])).toBe(`Bearer ${PRE_TOKEN}`);
    expect(sessionStorage.length).toBe(0);
  });

  it("shows ten backup codes in groups of four after the first setup", async () => {
    installFetch(setupHandlers());
    await toCodesScreen();

    const heading = screen.getByRole("heading", { name: "Save your backup codes" });
    expect(document.activeElement).toBe(heading);
    expect(screen.queryByText(SENTENCE.keepSafe)).not.toBeNull();
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(
      BACKUP_CODES.map((code) => (code.match(/.{4}/g) ?? []).join(" ")),
    );
    // The admin session exists on the server, but nothing is stored until the codes are saved.
    expect(sessionStorage.length).toBe(0);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await expectNoAxeViolations();
  });

  it("Continue stays disabled until the codes are saved", async () => {
    installFetch(setupHandlers());
    await toCodesScreen();

    const next = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.click(next);
    expect(sessionStorage.length).toBe(0);
    expect(router.state.location.pathname).toBe("/sign-in");

    const saved = screen.getByRole("checkbox", { name: "I have saved these codes" });
    fireEvent.click(saved);
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(saved);
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(sessionStorage.length).toBe(0);

    fireEvent.click(saved);
    await press("Continue");
    expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeTruthy();
    expect(sessionStorage.getItem(ACCESS_KEY)).toBe(ADMIN_TOKEN);
    expect(sessionStorage.getItem(HANDLE_KEY)).toBe(ADMIN_TOKEN);
    expect(sessionStorage.length).toBe(2);
  });

  it("an invited user reaches the accept screen after setup", async () => {
    const calls = installFetch(setupHandlers());
    setInviteToken(INVITE);
    await toCodesScreen();
    expect(getInviteToken()).toBe(INVITE);

    fireEvent.click(screen.getByRole("checkbox", { name: "I have saved these codes" }));
    await press("Continue");

    expect(await screen.findByRole("button", { name: "Accept invitation" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
    expect(getInviteToken()).toBe(INVITE);
    expect(callsTo(calls, "/v1/invitations/accept")).toHaveLength(0);
  });

  it("Copy puts the codes on the clipboard", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    installFetch(setupHandlers());
    await toCodesScreen();

    await press("Copy");
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(writeText).toHaveBeenCalledWith(
      BACKUP_CODES.map((code) => (code.match(/.{4}/g) ?? []).join(" ")).join("\n"),
    );
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("Copy says so when the clipboard is not available", async () => {
    installFetch(setupHandlers());
    await toCodesScreen();
    await press("Copy");
    await screen.findByText("Couldn't copy. Select the codes and copy them by hand.");
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("sets up a passkey and shows the backup codes", async () => {
    const { create } = stubWebAuthn();
    create.mockResolvedValue({
      id: "ignored",
      type: "public-key",
      rawId: buffer(1, 2, 3),
      response: { clientDataJSON: buffer(4, 5), attestationObject: buffer(6, 7, 8) },
    });
    const calls = installFetch(
      setupHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({
            secondFactor: "setup",
            methods: ["totp", "passkey"],
            passkeysAvailable: true,
          }),
        "/v1/auth/passkey/register/options": () => registrationOptions(),
        "/v1/auth/passkey/register/verify": () => adminAnswer({ backupCodes: BACKUP_CODES }),
      }),
    );
    await emailStep();
    await press("Use a passkey");
    await screen.findByRole("heading", { name: "Save your backup codes" });

    const options = callsTo(calls, "/v1/auth/passkey/register/options");
    expect(options).toHaveLength(1);
    expect(options[0]?.body).toEqual({});
    expect(sentAuthorization(options[0])).toBe(`Bearer ${PRE_TOKEN}`);
    expect(create).toHaveBeenCalledTimes(1);
    const made = create.mock.calls[0]?.[0]?.publicKey;
    expect(made?.rp.id).toBe(RP_ID);
    expect(made?.authenticatorSelection?.userVerification).toBe("required");
    expect(made?.authenticatorSelection?.residentKey).toBe("required");
    expect(made?.attestation).toBe("none");
    expect(made?.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
    expect(Array.from(new Uint8Array(made?.challenge as ArrayBuffer))).toEqual(CHALLENGE);
    expect(Array.from(new Uint8Array(made?.user.id as ArrayBuffer))).toEqual([7, 7, 7]);
    expect(
      (made?.excludeCredentials ?? []).map((entry) =>
        Array.from(new Uint8Array(entry.id as ArrayBuffer)),
      ),
    ).toEqual([[5, 5]]);
    const verify = callsTo(calls, "/v1/auth/passkey/register/verify");
    expect(verify).toHaveLength(1);
    expect(verify[0]?.body).toEqual({
      clientDataJSON: b64u(4, 5),
      attestationObject: b64u(6, 7, 8),
    });
    expect(sentAuthorization(verify[0])).toBe(`Bearer ${PRE_TOKEN}`);
    expect(sessionStorage.length).toBe(0);
  });

  it("a passkey that is not saved says so and saves nothing", async () => {
    const { create } = stubWebAuthn();
    create.mockRejectedValue(new DOMException("cancelled", "NotAllowedError"));
    const calls = installFetch(
      setupHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({
            secondFactor: "setup",
            methods: ["totp", "passkey"],
            passkeysAvailable: true,
          }),
        "/v1/auth/passkey/register/options": () => registrationOptions(),
      }),
    );
    await emailStep();
    await press("Use a passkey");

    await screen.findByText(SENTENCE.passkeyNotSaved);
    expect(screen.getByRole("alert").textContent).toBe(SENTENCE.passkeyNotSaved);
    expect(callsTo(calls, "/v1/auth/passkey/register/verify")).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Set up two-step sign-in" })).not.toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("a passkey the service refuses says it was not saved", async () => {
    const { create } = stubWebAuthn();
    create.mockResolvedValue({
      id: "ignored",
      type: "public-key",
      rawId: buffer(1),
      response: { clientDataJSON: buffer(4), attestationObject: buffer(6) },
    });
    installFetch(
      setupHandlers({
        "/v1/auth/email-otp/verify": () =>
          verifyAnswer({
            secondFactor: "setup",
            methods: ["totp", "passkey"],
            passkeysAvailable: true,
          }),
        "/v1/auth/passkey/register/options": () => registrationOptions(),
        "/v1/auth/passkey/register/verify": () => new Response(null, { status: 401 }),
      }),
    );
    await emailStep();
    await press("Use a passkey");
    await screen.findByText(SENTENCE.passkeyNotSaved);
  });

  it("writes no code, key, link or token to the console, the address, the title or storage", async () => {
    const writes = captureConsole();
    const sessionWrites = vi.spyOn(Object.getPrototypeOf(window.sessionStorage), "setItem");
    installFetch(setupHandlers());
    await toCodesScreen();
    fireEvent.click(screen.getByRole("checkbox", { name: "I have saved these codes" }));
    expect(window.location.href).not.toContain(SECRET);
    expect(document.title).not.toContain(SECRET);
    for (const code of BACKUP_CODES) {
      expect(document.title).not.toContain(code);
      expect(window.location.href).not.toContain(code);
    }
    await press("Continue");
    await screen.findByRole("heading", { name: "Users & Roles" });

    const dumped = writes.join("\n");
    for (const secret of [
      PRE_TOKEN,
      ADMIN_TOKEN,
      REFRESH,
      SECRET,
      OTPAUTH,
      TOTP_CODE,
      EMAIL,
      EMAIL_CODE,
      ...BACKUP_CODES,
    ]) {
      expect(dumped).not.toContain(secret);
    }
    const stored = sessionWrites.mock.calls.map((args) =>
      args.map((value) => String(value)).join(" "),
    );
    for (const secret of [PRE_TOKEN, REFRESH, SECRET, OTPAUTH, TOTP_CODE, ...BACKUP_CODES]) {
      expect(stored.join("\n")).not.toContain(secret);
    }
    expect(document.body.textContent).not.toContain(REFRESH);
    expect(document.body.textContent).not.toContain(PRE_TOKEN);
  });
});
