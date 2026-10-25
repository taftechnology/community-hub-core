import {
  opsEnrolmentStartBody,
  opsEnrolmentVerifyBody,
  opsPasskeyRegisterOptionsBody,
  opsPasskeyRegisterVerifyBody,
} from "@community-hub/contracts/ops";
import type { KmsPort } from "@community-hub/crypto";
import {
  beginOperatorPasskeyRegistration,
  finishOperatorPasskeyRegistration,
  readSessionWithKind,
  startOperatorEnrolment,
  verifyOperatorEnrolment,
  type OtpMail,
  type PasskeyRegistrationOptions,
  type VerifyOperatorEnrolmentResult,
} from "@community-hub/identity";

import type { Checkout } from "./checkout.js";
import type { GateRoute } from "./gate.js";
import {
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
        headers.append(
          "set-cookie",
          `${OPS_REFRESH_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        );
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

        const enrolmentSession = await deps.checkout("identity", (sql) =>
          readSessionWithKind(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
            kinds: ["enrolment"],
          }),
        );
        const activated = enrolmentSession === null;
        const headers = new Headers();
        if (activated) {
          headers.append(
            "set-cookie",
            `${OPS_ACCESS_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
          );
        }
        return jsonResponse(200, { activated }, headers);
      },
    },
  ];
}
