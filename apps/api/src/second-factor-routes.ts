import {
  freshPasskeyOptionsBody,
  freshPasskeyVerifyBody,
  freshTotpBody,
  regenerateBackupCodesBody,
  removePasskeyBody,
  removeTotpBody,
  secondFactorPasskeyOptionsBody,
  secondFactorPasskeyVerifyBody,
  secondFactorVerifyBody,
  totpConfirmBody,
  totpStartBody,
} from "@community-hub/contracts";
import {
  beginFreshPasskey,
  beginSecondStepPasskey,
  confirmTotpSetup,
  freshCheckTotp,
  listSecondFactors,
  regenerateBackupCodes,
  removePasskey,
  removeTotp,
  startEmailOtp,
  startTotpSetup,
  verifyFreshPasskey,
  verifySecondStep,
  verifySecondStepPasskey,
  type PasskeyAuthenticationOptions,
} from "@community-hub/identity";

import {
  adminRpIdFrom,
  adminTokensResponse,
  base64url,
  bearer,
  bytesFrom,
  empty,
  noticeDepsFor,
  parse,
  presentedHostname,
  type AuthDeps,
} from "./auth-routes.js";
import type { GateRoute } from "./gate.js";

type IdentitySql = Parameters<typeof startEmailOtp>[0];

function passkeyChallengeResponse(options: PasskeyAuthenticationOptions): Response {
  return Response.json(
    {
      challenge: base64url(options.challenge),
      rpId: options.rpId,
      userVerification: options.userVerification ?? "required",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export function secondFactorRoutes(deps: AuthDeps): GateRoute[] {
  function onAuth(request: Request): Response | undefined {
    if (presentedHostname(request) !== deps.authHostname.toLowerCase()) {
      return empty(404);
    }
    return undefined;
  }

  function identity<T>(run: (sql: IdentitySql) => Promise<T>): Promise<T> {
    return deps.checkout("identity", run);
  }

  function logRefusal(route: string, status: number): void {
    deps.log("second_factor", { route, status });
  }

  function mapOutcomeStatus(route: string, outcome: "refused" | "limited"): Response {
    const status = outcome === "limited" ? 429 : 401;
    logRefusal(route, status);
    return empty(status);
  }

  return [
    {
      method: "POST",
      pattern: "/v1/auth/second-factor/verify",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, secondFactorVerifyBody);
        if (body === undefined) {
          logRefusal("/v1/auth/second-factor/verify", 400);
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          logRefusal("/v1/auth/second-factor/verify", 401);
          return empty(401);
        }
        const result = await identity((sql) =>
          verifySecondStep(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
            method: body.method,
            code: body.code,
          }),
        );
        if (result.outcome !== "verified") {
          return mapOutcomeStatus("/v1/auth/second-factor/verify", result.outcome);
        }
        return adminTokensResponse(
          result.tokens,
          result.backupCodesLeft !== undefined
            ? { backupCodesLeft: result.backupCodesLeft }
            : undefined,
        );
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/second-factor/passkey/options",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const rpId = adminRpIdFrom(deps.adminOrigin);
        if (rpId === null) {
          return empty(404);
        }
        const body = await parse(request, secondFactorPasskeyOptionsBody);
        if (body === undefined) {
          logRefusal("/v1/auth/second-factor/passkey/options", 400);
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          logRefusal("/v1/auth/second-factor/passkey/options", 401);
          return empty(401);
        }
        const result = await identity((sql) =>
          beginSecondStepPasskey(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
            adminRpId: rpId,
          }),
        );
        if (result.outcome !== "started") {
          return mapOutcomeStatus("/v1/auth/second-factor/passkey/options", result.outcome);
        }
        return passkeyChallengeResponse(result.options);
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/second-factor/passkey/verify",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const rpId = adminRpIdFrom(deps.adminOrigin);
        if (rpId === null) {
          return empty(404);
        }
        const body = await parse(request, secondFactorPasskeyVerifyBody);
        if (body === undefined) {
          logRefusal("/v1/auth/second-factor/passkey/verify", 400);
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          logRefusal("/v1/auth/second-factor/passkey/verify", 401);
          return empty(401);
        }
        const result = await identity((sql) =>
          verifySecondStepPasskey(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
            adminRpId: rpId,
            credentialId: bytesFrom(body.credentialId),
            clientDataJSON: bytesFrom(body.clientDataJSON),
            authenticatorData: bytesFrom(body.authenticatorData),
            signature: bytesFrom(body.signature),
          }),
        );
        if (result.outcome !== "verified") {
          return mapOutcomeStatus("/v1/auth/second-factor/passkey/verify", result.outcome);
        }
        return adminTokensResponse(result.tokens);
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/second-factor/totp/start",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, totpStartBody);
        if (body === undefined) {
          logRefusal("/v1/auth/second-factor/totp/start", 400);
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          logRefusal("/v1/auth/second-factor/totp/start", 401);
          return empty(401);
        }
        const result = await identity((sql) =>
          startTotpSetup(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
            adminRpId: adminRpIdFrom(deps.adminOrigin),
          }),
        );
        if (result.outcome !== "started") {
          return mapOutcomeStatus("/v1/auth/second-factor/totp/start", result.outcome);
        }
        return Response.json(
          { secret: result.secret, otpauthUri: result.otpauthUri },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/second-factor/totp/confirm",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, totpConfirmBody);
        if (body === undefined) {
          logRefusal("/v1/auth/second-factor/totp/confirm", 400);
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          logRefusal("/v1/auth/second-factor/totp/confirm", 401);
          return empty(401);
        }
        const result = await identity((sql) =>
          confirmTotpSetup(
            sql,
            deps.kms,
            deps.keyArn,
            {
              accessToken: token,
              now: deps.now(),
              code: body.code,
              adminRpId: adminRpIdFrom(deps.adminOrigin),
            },
            noticeDepsFor(deps),
          ),
        );
        if (result.outcome !== "confirmed") {
          return mapOutcomeStatus("/v1/auth/second-factor/totp/confirm", result.outcome);
        }
        if (result.backupCodes !== undefined && result.tokens !== undefined) {
          return adminTokensResponse(result.tokens, { backupCodes: result.backupCodes });
        }
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/second-factor/fresh",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, freshTotpBody);
        if (body === undefined) {
          logRefusal("/v1/auth/second-factor/fresh", 400);
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          logRefusal("/v1/auth/second-factor/fresh", 401);
          return empty(401);
        }
        const result = await identity((sql) =>
          freshCheckTotp(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
            code: body.code,
          }),
        );
        if (result.outcome !== "fresh") {
          return mapOutcomeStatus("/v1/auth/second-factor/fresh", result.outcome);
        }
        return empty(204);
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/second-factor/fresh/passkey/options",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const rpId = adminRpIdFrom(deps.adminOrigin);
        if (rpId === null) {
          return empty(404);
        }
        const body = await parse(request, freshPasskeyOptionsBody);
        if (body === undefined) {
          logRefusal("/v1/auth/second-factor/fresh/passkey/options", 400);
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          logRefusal("/v1/auth/second-factor/fresh/passkey/options", 401);
          return empty(401);
        }
        const result = await identity((sql) =>
          beginFreshPasskey(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
            adminRpId: rpId,
          }),
        );
        if (result.outcome !== "started") {
          return mapOutcomeStatus("/v1/auth/second-factor/fresh/passkey/options", result.outcome);
        }
        return passkeyChallengeResponse(result.options);
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/second-factor/fresh/passkey/verify",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const rpId = adminRpIdFrom(deps.adminOrigin);
        if (rpId === null) {
          return empty(404);
        }
        const body = await parse(request, freshPasskeyVerifyBody);
        if (body === undefined) {
          logRefusal("/v1/auth/second-factor/fresh/passkey/verify", 400);
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          logRefusal("/v1/auth/second-factor/fresh/passkey/verify", 401);
          return empty(401);
        }
        const result = await identity((sql) =>
          verifyFreshPasskey(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
            adminRpId: rpId,
            credentialId: bytesFrom(body.credentialId),
            clientDataJSON: bytesFrom(body.clientDataJSON),
            authenticatorData: bytesFrom(body.authenticatorData),
            signature: bytesFrom(body.signature),
          }),
        );
        if (result.outcome !== "fresh") {
          return mapOutcomeStatus("/v1/auth/second-factor/fresh/passkey/verify", result.outcome);
        }
        return empty(204);
      },
    },
    {
      method: "GET",
      pattern: "/v1/auth/second-factor",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const token = bearer(request);
        if (token === undefined) {
          logRefusal("/v1/auth/second-factor", 401);
          return empty(401);
        }
        const result = await identity((sql) =>
          listSecondFactors(sql, deps.kms, deps.keyArn, {
            accessToken: token,
            now: deps.now(),
            adminRpId: adminRpIdFrom(deps.adminOrigin),
          }),
        );
        if (result.outcome !== "listed") {
          return mapOutcomeStatus("/v1/auth/second-factor", result.outcome);
        }
        return Response.json(
          {
            totp:
              result.totp === null ? null : { confirmedAt: result.totp.confirmedAt.toISOString() },
            passkeys: result.passkeys.map((item) => ({
              id: item.id,
              createdAt: item.createdAt === null ? null : item.createdAt.toISOString(),
            })),
            backupCodesLeft: result.backupCodesLeft,
            freshUntil: result.freshUntil === null ? null : result.freshUntil.toISOString(),
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/second-factor/totp/remove",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, removeTotpBody);
        if (body === undefined) {
          logRefusal("/v1/auth/second-factor/totp/remove", 400);
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          logRefusal("/v1/auth/second-factor/totp/remove", 401);
          return empty(401);
        }
        const result = await identity((sql) =>
          removeTotp(
            sql,
            deps.kms,
            deps.keyArn,
            {
              accessToken: token,
              now: deps.now(),
              adminRpId: adminRpIdFrom(deps.adminOrigin),
            },
            noticeDepsFor(deps),
          ),
        );
        if (result.outcome !== "removed") {
          return mapOutcomeStatus("/v1/auth/second-factor/totp/remove", result.outcome);
        }
        return empty(204);
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/second-factor/passkeys/remove",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, removePasskeyBody);
        if (body === undefined) {
          logRefusal("/v1/auth/second-factor/passkeys/remove", 400);
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          logRefusal("/v1/auth/second-factor/passkeys/remove", 401);
          return empty(401);
        }
        const result = await identity((sql) =>
          removePasskey(
            sql,
            deps.kms,
            deps.keyArn,
            {
              accessToken: token,
              now: deps.now(),
              adminRpId: adminRpIdFrom(deps.adminOrigin),
              passkeyId: body.passkeyId,
            },
            noticeDepsFor(deps),
          ),
        );
        if (result.outcome !== "removed") {
          return mapOutcomeStatus("/v1/auth/second-factor/passkeys/remove", result.outcome);
        }
        return empty(204);
      },
    },
    {
      method: "POST",
      pattern: "/v1/auth/second-factor/backup-codes",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        const denied = onAuth(request);
        if (denied !== undefined) {
          return denied;
        }
        const body = await parse(request, regenerateBackupCodesBody);
        if (body === undefined) {
          logRefusal("/v1/auth/second-factor/backup-codes", 400);
          return empty(400);
        }
        const token = bearer(request);
        if (token === undefined) {
          logRefusal("/v1/auth/second-factor/backup-codes", 401);
          return empty(401);
        }
        const result = await identity((sql) =>
          regenerateBackupCodes(
            sql,
            deps.kms,
            deps.keyArn,
            {
              accessToken: token,
              now: deps.now(),
            },
            noticeDepsFor(deps),
          ),
        );
        if (result.outcome !== "made") {
          return mapOutcomeStatus("/v1/auth/second-factor/backup-codes", result.outcome);
        }
        return Response.json(
          { backupCodes: result.backupCodes },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  ];
}
