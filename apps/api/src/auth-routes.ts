import {
  passkeyAuthenticateOptionsBody,
  passkeyAuthenticateVerifyBody,
  passkeyRegisterOptionsBody,
  passkeyRegisterVerifyBody,
  refreshSessionBody,
  startEmailOtpBody,
  verifyEmailOtpBody,
} from "@community-hub/contracts";
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  IdentityError,
  readSession,
  refreshSession,
  startEmailOtp,
  verifyEmailOtp,
  type OtpMail,
  type SessionTokens,
} from "@community-hub/identity";
import type { GateRoute } from "./gate.js";
import type { Checkout } from "./checkout.js";

type IdentitySql = Parameters<typeof startEmailOtp>[0];
type IdentityKms = Parameters<typeof startEmailOtp>[1];

export type AuthLog = (message: string, fields: Record<string, unknown>) => void;

export type AuthDeps = {
  checkout: Checkout<IdentitySql>;
  kms: IdentityKms;
  keyArn: string;
  mail: OtpMail;
  now: () => Date;
  authHostname: string;
  log: AuthLog;
};

function empty(status: number): Response {
  return new Response(null, { status });
}

function presentedHostname(request: Request): string | undefined {
  const raw = request.headers.get("x-community-hub-hostname");
  if (raw === null || raw === "") {
    return undefined;
  }
  return raw.toLowerCase();
}

function jsonMediaType(request: Request): boolean {
  const raw = request.headers.get("content-type");
  if (raw === null) {
    return false;
  }
  return raw.split(";")[0]?.trim().toLowerCase() === "application/json";
}

async function parse<T>(
  request: Request,
  schema: {
    safeParse(data: unknown): { success: true; data: T } | { success: false };
  },
): Promise<T | undefined> {
  if (!jsonMediaType(request)) {
    return undefined;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

function bearer(request: Request): string | undefined {
  const raw = request.headers.get("authorization");
  if (raw === null) {
    return undefined;
  }
  const match = /^Bearer (\S+)$/i.exec(raw);
  return match?.[1];
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function bytesFrom(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function tokens(value: SessionTokens): Response {
  return Response.json(
    {
      userId: value.userId,
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresIn: value.expiresIn,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function statusFor(error: unknown): Response | undefined {
  if (!(error instanceof IdentityError)) {
    return undefined;
  }
  if (error.code === "email_unavailable") {
    return empty(503);
  }
  if (error.code === "invalid_email" || error.code === "invalid_ceremony") {
    return empty(400);
  }
  return undefined;
}

export function authRoutes(deps: AuthDeps): GateRoute[] {
  async function onAuth(request: Request): Promise<Response | undefined> {
    if (presentedHostname(request) !== deps.authHostname.toLowerCase()) {
      return empty(404);
    }
    return undefined;
  }

  function identity<T>(run: (sql: IdentitySql) => Promise<T>): Promise<T> {
    return deps.checkout("identity", run);
  }

  return [
    {
      method: "POST",
      pattern: "/v1/auth/email-otp/start",
      surface: "tenant",
      handle: async (request) => {
        const denied = await onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, startEmailOtpBody);
        if (body === undefined) {
          return empty(400);
        }
        try {
          await identity((sql) =>
            startEmailOtp(sql, deps.kms, deps.keyArn, deps.mail, {
              email: body.email,
              now: deps.now(),
            }),
          );
        } catch (error) {
          const response = statusFor(error);
          if (response !== undefined) {
            return response;
          }
          throw error;
        }
        return empty(204);
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/email-otp/verify",
      surface: "tenant",
      handle: async (request) => {
        const denied = await onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, verifyEmailOtpBody);
        if (body === undefined) {
          return empty(400);
        }
        const session = await identity((sql) =>
          verifyEmailOtp(sql, deps.kms, deps.keyArn, {
            email: body.email,
            code: body.code,
            now: deps.now(),
          }),
        );
        return session === null ? empty(401) : tokens(session);
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/passkey/register/options",
      surface: "tenant",
      handle: async (request) => {
        const denied = await onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, passkeyRegisterOptionsBody);
        if (body === undefined) {
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          return empty(401);
        }
        const session = await identity((sql) =>
          readSession(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
          }),
        );
        if (session === null) {
          return empty(401);
        }
        try {
          const options = await identity((sql) =>
            beginPasskeyRegistration(sql, {
              userId: session.userId,
              rpId: deps.authHostname,
              now: deps.now(),
            }),
          );
          return Response.json({
            challenge: base64url(options.challenge),
            rp: options.rp,
            user: {
              id: base64url(options.user.id),
              name: options.user.name,
              displayName: options.user.displayName,
            },
            pubKeyCredParams: options.pubKeyCredParams,
            attestation: options.attestation,
            authenticatorSelection: options.authenticatorSelection,
          });
        } catch (error) {
          const response = statusFor(error);
          if (response !== undefined) {
            return response;
          }
          throw error;
        }
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/passkey/register/verify",
      surface: "tenant",
      handle: async (request) => {
        const denied = await onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, passkeyRegisterVerifyBody);
        if (body === undefined) {
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          return empty(401);
        }
        const session = await identity((sql) =>
          readSession(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
          }),
        );
        if (session === null) {
          return empty(401);
        }
        try {
          await identity((sql) =>
            finishPasskeyRegistration(sql, {
              userId: session.userId,
              rpId: deps.authHostname,
              now: deps.now(),
              clientDataJSON: bytesFrom(body.clientDataJSON),
              attestationObject: bytesFrom(body.attestationObject),
            }),
          );
        } catch (error) {
          const response = statusFor(error);
          if (response !== undefined) {
            return response;
          }
          throw error;
        }
        return empty(204);
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/passkey/authenticate/options",
      surface: "tenant",
      handle: async (request) => {
        const denied = await onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, passkeyAuthenticateOptionsBody);
        if (body === undefined) {
          return empty(400);
        }
        const options = await identity((sql) =>
          beginPasskeyAuthentication(sql, {
            rpId: deps.authHostname,
            now: deps.now(),
          }),
        );
        return Response.json({
          challenge: base64url(options.challenge),
          rpId: options.rpId,
        });
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/passkey/authenticate/verify",
      surface: "tenant",
      handle: async (request) => {
        const denied = await onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, passkeyAuthenticateVerifyBody);
        if (body === undefined) {
          return empty(400);
        }
        const session = await identity((sql) =>
          finishPasskeyAuthentication(sql, deps.kms, deps.keyArn, {
            rpId: deps.authHostname,
            now: deps.now(),
            credentialId: bytesFrom(body.credentialId),
            clientDataJSON: bytesFrom(body.clientDataJSON),
            authenticatorData: bytesFrom(body.authenticatorData),
            signature: bytesFrom(body.signature),
          }),
        );
        return session === null ? empty(401) : tokens(session);
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/session/refresh",
      surface: "tenant",
      handle: async (request) => {
        const denied = await onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, refreshSessionBody);
        if (body === undefined) {
          return empty(400);
        }
        const session = await identity((sql) =>
          refreshSession(sql, deps.kms, deps.keyArn, {
            refreshToken: body.refreshToken,
            now: deps.now(),
          }),
        );
        return session === null ? empty(401) : tokens(session);
      },
    },
  ];
}
