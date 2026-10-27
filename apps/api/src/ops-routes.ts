import {
  opsEnrolmentStartBody,
  opsEnrolmentVerifyBody,
  opsPasskeyAuthenticateOptionsBody,
  opsPasskeyAuthenticateVerifyBody,
  opsPasskeyRegisterOptionsBody,
  opsPasskeyRegisterVerifyBody,
  opsSessionEndBody,
  opsSessionRefreshBody,
} from "@community-hub/contracts/ops";
import type { KmsPort } from "@community-hub/crypto";
import {
  beginOperatorAuthentication,
  beginOperatorPasskeyRegistration,
  endOperatorSession,
  finishOperatorAuthentication,
  finishOperatorPasskeyRegistration,
  readOperatorSession,
  readSessionWithKind,
  refreshOperatorSession,
  startOperatorEnrolment,
  verifyOperatorEnrolment,
  type OtpMail,
  type PasskeyRegistrationOptions,
  type SessionTokens,
  type VerifyOperatorEnrolmentResult,
} from "@community-hub/identity";
import { listDirectory } from "@community-hub/tenancy";

import type { Checkout } from "./checkout.js";
import type { GateRoute } from "./gate.js";
import {
  clearCookie,
  clearSessionCookies,
  OPS_ACCESS_COOKIE,
  OPS_REFRESH_COOKIE,
  originAllowed,
  readJson,
  readOpsCookie,
  setSessionCookies,
} from "./ops-cookies.js";

type OpsSql = Parameters<typeof startOperatorEnrolment>[0];

export const DEFAULT_OPS_PERMISSIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ["platform_admin", ["ops.directory.view"]],
  ["platform_support", ["ops.directory.view"]],
  ["platform_security", ["ops.directory.view"]],
]);

export const OPS_RP_NAME = "Community Hub operations";
export const OPS_USER_LABEL = "Community Hub operator";

export type OpsDeps = {
  checkout: Checkout<OpsSql>;
  kms: KmsPort;
  keyArn: string;
  mail: OtpMail;
  now: () => Date;
  opsHostname: string;
  permissions?: ReadonlyMap<string, readonly string[]> | undefined;
  log: (message: string) => void;
};

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function bytesFrom(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function empty(status: number, headersInit?: Headers): Response {
  const headers = new Headers(headersInit);
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "no-store");
  }
  return new Response(null, { status, headers });
}

function jsonResponse(status: number, body: unknown, headersInit?: Headers): Response {
  const headers = new Headers(headersInit);
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "no-store");
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function opsRoutes(deps: OpsDeps): GateRoute[] {
  const opsRpId = deps.opsHostname.toLowerCase();

  return [
    {
      method: "POST",
      pattern: "/v1/ops/enrolment/start",
      surface: "ops",
      billing: "exempt",
      handle: async (request) => {
        if (!originAllowed(request, deps.opsHostname)) {
          return empty(403);
        }
        const body = await readJson(request, opsEnrolmentStartBody);
        if (body === undefined) {
          return empty(400);
        }
        void Promise.resolve()
          .then(() =>
            deps.checkout("identity", (sql) =>
              startOperatorEnrolment(sql, deps.kms, deps.keyArn, deps.mail, {
                email: body.email,
                now: deps.now(),
              }),
            ),
          )
          .catch(() => deps.log("ops_enrolment_start_failed"));
        return empty(204);
      },
    },
    {
      method: "POST",
      pattern: "/v1/ops/enrolment/verify",
      surface: "ops",
      billing: "exempt",
      handle: async (request) => {
        if (!originAllowed(request, deps.opsHostname)) {
          return empty(403);
        }
        const body = await readJson(request, opsEnrolmentVerifyBody);
        if (body === undefined) {
          return empty(400);
        }
        const result = (await deps.checkout("identity", (sql) =>
          verifyOperatorEnrolment(sql, deps.kms, deps.keyArn, {
            email: body.email,
            emailCode: body.emailCode,
            enrolmentCode: body.enrolmentCode,
            opsRpId,
            now: deps.now(),
          }),
        )) as VerifyOperatorEnrolmentResult;

        if (result === null) {
          const headers = new Headers();
          clearSessionCookies(headers);
          return empty(401, headers);
        }

        if (result.kind === "activated") {
          const headers = new Headers();
          clearSessionCookies(headers);
          return jsonResponse(200, { status: "activated" }, headers);
        }

        const headers = new Headers();
        setSessionCookies(headers, { access: result.session.accessToken });
        clearCookie(headers, OPS_REFRESH_COOKIE);
        return jsonResponse(200, { status: "enrolment" }, headers);
      },
    },
    {
      method: "POST",
      pattern: "/v1/ops/passkey/register/options",
      surface: "ops",
      billing: "exempt",
      handle: async (request) => {
        if (!originAllowed(request, deps.opsHostname)) {
          return empty(403);
        }
        const body = await readJson(request, opsPasskeyRegisterOptionsBody);
        if (body === undefined) {
          return empty(400);
        }
        const token = readOpsCookie(request, OPS_ACCESS_COOKIE);
        if (token === undefined) {
          return empty(401);
        }
        const session = await deps.checkout("identity", (sql) =>
          readSessionWithKind(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
            kinds: ["enrolment", "operator"],
          }),
        );
        if (session === null) {
          return empty(401);
        }
        const options = (await deps.checkout("identity", (sql) =>
          beginOperatorPasskeyRegistration(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            opsRpId,
            now: deps.now(),
          }),
        )) as PasskeyRegistrationOptions | null;

        if (options === null) {
          return empty(401);
        }

        return jsonResponse(200, {
          challenge: base64url(options.challenge),
          rp: {
            id: options.rp.id,
            name: OPS_RP_NAME,
          },
          user: {
            id: base64url(options.user.id),
            name: OPS_USER_LABEL,
            displayName: OPS_USER_LABEL,
          },
          pubKeyCredParams: options.pubKeyCredParams,
          attestation: options.attestation,
          authenticatorSelection: options.authenticatorSelection,
          excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({
            type: "public-key",
            id: base64url(c.id),
          })),
        });
      },
    },
    {
      method: "POST",
      pattern: "/v1/ops/passkey/register/verify",
      surface: "ops",
      billing: "exempt",
      handle: async (request) => {
        if (!originAllowed(request, deps.opsHostname)) {
          return empty(403);
        }
        const body = await readJson(request, opsPasskeyRegisterVerifyBody);
        if (body === undefined) {
          return empty(400);
        }
        const token = readOpsCookie(request, OPS_ACCESS_COOKIE);
        if (token === undefined) {
          return empty(401);
        }
        const session = await deps.checkout("identity", (sql) =>
          readSessionWithKind(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
            kinds: ["enrolment", "operator"],
          }),
        );
        if (session === null) {
          return empty(401);
        }
        const ok = (await deps.checkout("identity", (sql) =>
          finishOperatorPasskeyRegistration(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            opsRpId,
            now: deps.now(),
            clientDataJSON: bytesFrom(body.clientDataJSON),
            attestationObject: bytesFrom(body.attestationObject),
          }),
        )) as boolean;

        if (!ok) {
          return empty(400);
        }

        const activated =
          session.kind === "enrolment" &&
          (await deps.checkout("identity", (sql) =>
            readSessionWithKind(sql, deps.kms, deps.keyArn, {
              accessToken: token,
              now: deps.now(),
              kinds: ["enrolment"],
            }),
          )) === null;
        const headers = new Headers();
        if (activated) {
          clearCookie(headers, OPS_ACCESS_COOKIE);
        }
        return jsonResponse(200, { activated }, headers);
      },
    },
    {
      method: "POST",
      pattern: "/v1/ops/passkey/authenticate/options",
      surface: "ops",
      billing: "exempt",
      handle: async (request) => {
        if (!originAllowed(request, deps.opsHostname)) {
          return empty(403);
        }
        const body = await readJson(request, opsPasskeyAuthenticateOptionsBody);
        if (body === undefined) {
          return empty(400);
        }
        const options = await deps.checkout("identity", (sql) =>
          beginOperatorAuthentication(sql, {
            opsRpId,
            now: deps.now(),
          }),
        );
        return jsonResponse(200, {
          challenge: base64url(options.challenge),
          rpId: options.rpId,
          ...(options.userVerification !== undefined
            ? { userVerification: options.userVerification }
            : {}),
        });
      },
    },
    {
      method: "POST",
      pattern: "/v1/ops/passkey/authenticate/verify",
      surface: "ops",
      billing: "exempt",
      handle: async (request) => {
        if (!originAllowed(request, deps.opsHostname)) {
          return empty(403);
        }
        const body = await readJson(request, opsPasskeyAuthenticateVerifyBody);
        if (body === undefined) {
          return empty(400);
        }
        const tokens = (await deps.checkout("identity", (sql) =>
          finishOperatorAuthentication(sql, deps.kms, deps.keyArn, {
            opsRpId,
            now: deps.now(),
            credentialId: bytesFrom(body.credentialId),
            clientDataJSON: bytesFrom(body.clientDataJSON),
            authenticatorData: bytesFrom(body.authenticatorData),
            signature: bytesFrom(body.signature),
          }),
        )) as SessionTokens | null;

        if (tokens === null) {
          const headers = new Headers();
          clearSessionCookies(headers);
          return empty(401, headers);
        }

        const headers = new Headers();
        setSessionCookies(headers, {
          access: tokens.accessToken,
          refresh: tokens.refreshToken,
        });
        return jsonResponse(200, { expiresIn: tokens.expiresIn }, headers);
      },
    },
    {
      method: "POST",
      pattern: "/v1/ops/session/refresh",
      surface: "ops",
      billing: "exempt",
      handle: async (request) => {
        if (!originAllowed(request, deps.opsHostname)) {
          return empty(403);
        }
        const body = await readJson(request, opsSessionRefreshBody);
        if (body === undefined) {
          return empty(400);
        }
        const refreshToken = readOpsCookie(request, OPS_REFRESH_COOKIE);
        if (refreshToken === undefined) {
          const headers = new Headers();
          clearSessionCookies(headers);
          return empty(401, headers);
        }
        const tokens = (await deps.checkout("identity", (sql) =>
          refreshOperatorSession(sql, deps.kms, deps.keyArn, {
            refreshToken,
            now: deps.now(),
          }),
        )) as SessionTokens | null;

        if (tokens === null) {
          const headers = new Headers();
          clearSessionCookies(headers);
          return empty(401, headers);
        }

        const headers = new Headers();
        setSessionCookies(headers, {
          access: tokens.accessToken,
          refresh: tokens.refreshToken,
        });
        return jsonResponse(200, { expiresIn: tokens.expiresIn }, headers);
      },
    },
    {
      method: "POST",
      pattern: "/v1/ops/session/end",
      surface: "ops",
      billing: "exempt",
      handle: async (request) => {
        if (!originAllowed(request, deps.opsHostname)) {
          return empty(403);
        }
        const body = await readJson(request, opsSessionEndBody);
        if (body === undefined) {
          return empty(400);
        }
        const token = readOpsCookie(request, OPS_ACCESS_COOKIE);
        if (token !== undefined) {
          await deps.checkout("identity", (sql) =>
            endOperatorSession(sql, deps.kms, deps.keyArn, {
              accessToken: token,
              now: deps.now(),
            }),
          );
        }
        const headers = new Headers();
        clearSessionCookies(headers);
        return empty(204, headers);
      },
    },
    {
      method: "GET",
      pattern: "/v1/ops/me",
      surface: "ops",
      billing: "exempt",
      handle: async (request) => {
        const token = readOpsCookie(request, OPS_ACCESS_COOKIE);
        if (token === undefined) {
          return empty(401);
        }
        const session = await deps.checkout("identity", (sql) =>
          readOperatorSession(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
          }),
        );
        if (session === null) {
          return empty(401);
        }
        return jsonResponse(200, { roles: session.roles });
      },
    },
    {
      method: "GET",
      pattern: "/v1/ops/directory",
      surface: "ops",
      billing: "exempt",
      handle: async (request) => {
        const token = readOpsCookie(request, OPS_ACCESS_COOKIE);
        if (token === undefined) {
          return empty(401);
        }
        const session = await deps.checkout("identity", (sql) =>
          readOperatorSession(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
          }),
        );
        if (session === null) {
          return empty(401);
        }
        const permissions = deps.permissions ?? DEFAULT_OPS_PERMISSIONS;
        const hasPermission = session.roles.some((role) =>
          permissions.get(role)?.includes("ops.directory.view"),
        );
        if (!hasPermission) {
          return empty(403);
        }
        const directory = await deps.checkout("platform", (sql) => listDirectory(sql));
        return jsonResponse(200, directory);
      },
    },
  ];
}
