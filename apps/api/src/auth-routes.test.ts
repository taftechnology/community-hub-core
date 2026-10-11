import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({
  startEmailOtp: vi.fn(),
  verifyEmailOtp: vi.fn(),
  beginPasskeyRegistration: vi.fn(),
  finishPasskeyRegistration: vi.fn(),
  beginPasskeyAuthentication: vi.fn(),
  finishPasskeyAuthentication: vi.fn(),
  readSession: vi.fn(),
  refreshSession: vi.fn(),
}));

vi.mock("@community-hub/identity", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/identity")>("@community-hub/identity");
  return { ...actual, ...identity };
});

import { OtpMailUnavailable } from "@community-hub/identity";

import { authRoutes, type AuthDeps } from "./auth-routes.js";

const AUTH_HOSTNAME = "auth.au.example.test";
const API_HOSTNAME = "au.api.example.test";

function deps(log: AuthDeps["log"] = () => undefined): AuthDeps {
  return {
    checkout: (_role, run) => run({} as never),
    kms: {} as AuthDeps["kms"],
    keyArn: "arn:aws:kms:ap-southeast-2:123456789012:key/mrk-example",
    mail: { send: () => Promise.resolve() },
    now: () => new Date("2026-10-11T00:00:00.000Z"),
    authHostname: AUTH_HOSTNAME,
    log,
  };
}

function request(path: string, hostname: string, body: unknown, authorization?: string): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "x-community-hub-hostname": hostname,
  });
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function route(path: string, bound: AuthDeps = deps()) {
  const found = authRoutes(bound).find((item) => item.pattern === path);
  if (found === undefined) {
    throw new Error(`missing ${path}`);
  }
  return found;
}

describe("auth routes", () => {
  it("registers the seven tenant routes", () => {
    const routes = authRoutes(deps());
    expect(routes.map((item) => `${item.method} ${item.pattern}`)).toEqual([
      "POST /v1/auth/email-otp/start",
      "POST /v1/auth/email-otp/verify",
      "POST /v1/auth/passkey/register/options",
      "POST /v1/auth/passkey/register/verify",
      "POST /v1/auth/passkey/authenticate/options",
      "POST /v1/auth/passkey/authenticate/verify",
      "POST /v1/auth/session/refresh",
    ]);
    expect(routes.every((item) => item.surface === "tenant")).toBe(true);
    const source = readFileSync(new URL("./auth-routes.ts", import.meta.url), "utf8");
    expect(source).toContain('checkout("identity"');
    expect(source).not.toContain('checkout("app"');
    expect(source).not.toContain('checkout("platform"');
  });

  it("starts on the auth hostname and hides the address from the logger", async () => {
    identity.startEmailOtp.mockResolvedValue(undefined);
    const entries: unknown[] = [];
    const bound = deps((message, fields) => {
      entries.push({ message, fields });
    });
    const response = await route("/v1/auth/email-otp/start", bound).handle(
      request("/v1/auth/email-otp/start", AUTH_HOSTNAME, { email: "ada@example.com" }),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(identity.startEmailOtp).toHaveBeenCalledOnce();

    identity.verifyEmailOtp.mockResolvedValue(null);
    const verify = await route("/v1/auth/email-otp/verify", bound).handle(
      request("/v1/auth/email-otp/verify", AUTH_HOSTNAME, {
        email: "ada@example.com",
        code: "01234567",
      }),
    );
    expect(verify.status).toBe(401);
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain("ada@example.com");
    expect(logged).not.toContain("01234567");
  });

  it("returns 404 with an empty body on the api hostname", async () => {
    identity.startEmailOtp.mockClear();
    const response = await route("/v1/auth/email-otp/start").handle(
      request("/v1/auth/email-otp/start", API_HOSTNAME, { email: "ada@example.com" }),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(identity.startEmailOtp).not.toHaveBeenCalled();
  });

  it("returns tokens when verify succeeds and 401 when it does not", async () => {
    identity.verifyEmailOtp.mockResolvedValueOnce(null);
    const missing = await route("/v1/auth/email-otp/verify").handle(
      request("/v1/auth/email-otp/verify", AUTH_HOSTNAME, {
        email: "ada@example.com",
        code: "01234567",
      }),
    );
    expect(missing.status).toBe(401);
    expect(await missing.text()).toBe("");

    identity.verifyEmailOtp.mockResolvedValueOnce({
      userId: "user-1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 900,
    });
    const verified = await route("/v1/auth/email-otp/verify").handle(
      request("/v1/auth/email-otp/verify", AUTH_HOSTNAME, {
        email: "ada@example.com",
        code: "01234567",
      }),
    );
    expect(verified.status).toBe(200);
    expect(verified.headers.get("cache-control")).toBe("no-store");
    expect(await verified.json()).toEqual({
      userId: "user-1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 900,
    });
  });

  it("returns 401 for register options without a bearer token", async () => {
    identity.beginPasskeyRegistration.mockClear();
    const response = await route("/v1/auth/passkey/register/options").handle(
      request("/v1/auth/passkey/register/options", AUTH_HOSTNAME, {}),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(identity.beginPasskeyRegistration).not.toHaveBeenCalled();
  });

  it("sends no-store on passkey and refresh token responses", async () => {
    const session = {
      userId: "user-1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 900 as const,
    };
    identity.finishPasskeyAuthentication.mockResolvedValueOnce(session);
    const authenticated = await route("/v1/auth/passkey/authenticate/verify").handle(
      request("/v1/auth/passkey/authenticate/verify", AUTH_HOSTNAME, {
        credentialId: "YQ",
        clientDataJSON: "YQ",
        authenticatorData: "YQ",
        signature: "YQ",
      }),
    );
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get("cache-control")).toBe("no-store");

    identity.refreshSession.mockResolvedValueOnce(session);
    const refreshed = await route("/v1/auth/session/refresh").handle(
      request("/v1/auth/session/refresh", AUTH_HOSTNAME, { refreshToken: "refresh-token" }),
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 503 with an empty body when mail is unavailable", async () => {
    identity.startEmailOtp.mockRejectedValue(new OtpMailUnavailable());
    const response = await route("/v1/auth/email-otp/start").handle(
      request("/v1/auth/email-otp/start", AUTH_HOSTNAME, { email: "ada@example.com" }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });
});
