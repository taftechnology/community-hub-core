import {
  endSessionBody,
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
  beginTenantPasskeyRegistration,
  endSession,
  finishTenantPasskeyRegistration,
  IdentityError,
  readSecondFactorPrompt,
  refreshSession,
  signInWithPasskey,
  startEmailOtp,
  verifyEmailOtp,
  type OtpMail,
  type SecondFactorNotice,
  type SecondFactorNoticeDeps,
  type SessionKind,
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
  notice: SecondFactorNotice;
  now: () => Date;
  authHostname: string;
  adminOrigin?: string | undefined;
  log: AuthLog;
};

export function empty(status: number): Response {
  return new Response(null, { status });
}

export function presentedHostname(request: Request): string | undefined {
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

export async function parse<T>(
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

export function bearer(request: Request): string | undefined {
  const raw = request.headers.get("authorization");
  if (raw === null) {
    return undefined;
  }
  const match = /^Bearer (\S+)$/i.exec(raw);
  return match?.[1];
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function bytesFrom(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export function adminRpIdFrom(adminOrigin: string | undefined): string | null {
  if (adminOrigin === undefined || adminOrigin === "") {
    return null;
  }
  return new URL(adminOrigin).hostname;
}

export function noticeDepsFor(deps: AuthDeps): SecondFactorNoticeDeps {
  return {
    notice: deps.notice,
    log: (fields) => {
      deps.log(fields.event, { kind: fields.kind });
    },
  };
}

function tokens(
  value: SessionTokens,
  options: { kind?: SessionKind; extra?: Record<string, unknown> } = {},
): Response {
  if (options.kind === "second_factor") {
    return Response.json(
      {
        ...options.extra,
        accessToken: value.accessToken,
        expiresIn: value.expiresIn,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
  return Response.json(
    {
      ...options.extra,
      userId: value.userId,
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresIn: value.expiresIn,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export function adminTokensResponse(
  value: SessionTokens,
  extra?: Record<string, unknown>,
): Response {
  return tokens(value, extra === undefined ? {} : { extra });
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
      billing: "exempt",
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
      billing: "exempt",
      handle: async (request) => {
        const denied = await onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, verifyEmailOtpBody);
        if (body === undefined) {
          return empty(400);
        }
        const rpId = adminRpIdFrom(deps.adminOrigin);
        const verified = await identity(async (sql) => {
          const session = await verifyEmailOtp(sql, deps.kms, deps.keyArn, {
            email: body.email,
            code: body.code,
            now: deps.now(),
          });
          if (session === null) {
            return null;
          }
          const prompt = await readSecondFactorPrompt(sql, {
            userId: session.userId,
            adminRpId: rpId,
          });
          return { session, prompt };
        });
        if (verified === null) {
          deps.log("auth", { route: "/v1/auth/email-otp/verify", status: 401 });
          return empty(401);
        }
        return tokens(verified.session, {
          kind: "second_factor",
          extra: {
            secondFactor: verified.prompt.secondFactor,
            methods: verified.prompt.methods,
            passkeysAvailable: rpId !== null,
          },
        });
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/passkey/register/options",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = await onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const rpId = adminRpIdFrom(deps.adminOrigin);
        if (rpId === null) {
          return empty(404);
        }
        const body = await parse(request, passkeyRegisterOptionsBody);
        if (body === undefined) {
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          return empty(401);
        }
        const result = await identity((sql) =>
          beginTenantPasskeyRegistration(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
            adminRpId: rpId,
          }),
        );
        if (result.outcome !== "started") {
          deps.log("second_factor", { route: "/v1/auth/passkey/register/options", status: 401 });
          return empty(401);
        }
        const { options } = result;
        return Response.json(
          {
            challenge: base64url(options.challenge),
            rp: { id: options.rp.id, name: "Community Hub" },
            user: {
              id: base64url(options.user.id),
              name: options.user.name,
              displayName: options.user.displayName,
            },
            pubKeyCredParams: options.pubKeyCredParams,
            attestation: options.attestation,
            authenticatorSelection: options.authenticatorSelection,
            excludeCredentials: (options.excludeCredentials ?? []).map((cred) => ({
              type: cred.type,
              id: base64url(cred.id),
            })),
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/passkey/register/verify",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = await onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const rpId = adminRpIdFrom(deps.adminOrigin);
        if (rpId === null) {
          return empty(404);
        }
        const body = await parse(request, passkeyRegisterVerifyBody);
        if (body === undefined) {
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          return empty(401);
        }
        const result = await identity((sql) =>
          finishTenantPasskeyRegistration(
            sql,
            deps.kms,
            deps.keyArn,
            {
              accessToken: token,
              now: deps.now(),
              adminRpId: rpId,
              clientDataJSON: bytesFrom(body.clientDataJSON),
              attestationObject: bytesFrom(body.attestationObject),
            },
            noticeDepsFor(deps),
          ),
        );
        if (result.outcome !== "enrolled") {
          deps.log("second_factor", { route: "/v1/auth/passkey/register/verify", status: 401 });
          return empty(401);
        }
        if (result.backupCodes !== undefined && result.tokens !== undefined) {
          return tokens(result.tokens, { extra: { backupCodes: result.backupCodes } });
        }
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/passkey/authenticate/options",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = await onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const rpId = adminRpIdFrom(deps.adminOrigin);
        if (rpId === null) {
          return empty(404);
        }
        const body = await parse(request, passkeyAuthenticateOptionsBody);
        if (body === undefined) {
          return empty(400);
        }
        const options = await identity((sql) =>
          beginPasskeyAuthentication(sql, {
            rpId,
            now: deps.now(),
            userVerification: "required",
          }),
        );
        return Response.json(
          {
            challenge: base64url(options.challenge),
            rpId: options.rpId,
            userVerification: options.userVerification ?? "required",
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/passkey/authenticate/verify",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = await onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const rpId = adminRpIdFrom(deps.adminOrigin);
        if (rpId === null) {
          return empty(404);
        }
        const body = await parse(request, passkeyAuthenticateVerifyBody);
        if (body === undefined) {
          return empty(400);
        }
        const result = await identity((sql) =>
          signInWithPasskey(sql, deps.kms, deps.keyArn, {
            adminRpId: rpId,
            now: deps.now(),
            credentialId: bytesFrom(body.credentialId),
            clientDataJSON: bytesFrom(body.clientDataJSON),
            authenticatorData: bytesFrom(body.authenticatorData),
            signature: bytesFrom(body.signature),
          }),
        );
        if (result.outcome !== "signed_in") {
          deps.log("second_factor", { route: "/v1/auth/passkey/authenticate/verify", status: 401 });
          return empty(401);
        }
        return tokens(result.tokens);
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/session/refresh",
      surface: "tenant",
      billing: "exempt",
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
    {
      method: "POST",
      pattern: "/v1/auth/session/end",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = await onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const token = bearer(request);
        if (token === undefined) {
          return empty(401);
        }
        const body = await parse(request, endSessionBody);
        if (body === undefined) {
          return empty(400);
        }
        await identity((sql) =>
          endSession(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
          }),
        );
        return new Response(null, {
          status: 204,
          headers: { "cache-control": "no-store" },
        });
      },
    },
  ];
}
