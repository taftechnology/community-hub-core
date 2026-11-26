import { createHash, createHmac, generateKeyPairSync, sign as signDer } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner, type InvitationMail } from "@community-hub/access";
import {
  adminSessionAnswer,
  firstFactorBackupCodesAnswer,
  passkeyAuthenticateOptionsAnswer,
  passkeyRegisterOptionsAnswer,
  regenerateBackupCodesAnswer,
  secondFactorListAnswer,
  secondFactorVerifyAnswer,
  totpStartAnswer,
  verifyEmailOtpAnswer,
} from "@community-hub/contracts";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { assignPlan, upsertPlan } from "@community-hub/entitlements";
import {
  type OtpMail,
  type SecondFactorNotice,
  type SecondFactorNoticeKind,
} from "@community-hub/identity";
import { withRequest } from "@community-hub/kernel";
import { createPerson } from "@community-hub/people";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { accessRoutes } from "./access-routes.js";
import { authRoutes, type AuthDeps } from "./auth-routes.js";
import type { Role } from "./checkout.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { invitationRoutes } from "./invitation-routes.js";
import { secondFactorRoutes } from "./second-factor-routes.js";
import { startServer } from "./server.js";
import { encodeCbor, type Cbor } from "../../../modules/core/identity/domain/cbor.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const API_HOSTNAME = "au.api.example.test";
const AUTH_HOSTNAME = "auth.au.example.test";
const ADMIN_ORIGIN = "https://admin.au.example.test";
const ADMIN_RP_ID = "admin.au.example.test";
const REQUEST_ID = "88888888-8888-4888-8888-888888888888";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(value: string): Uint8Array {
  const clean = value.replace(/=+$/u, "").toUpperCase();
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) {
      throw new Error("invalid base32");
    }
    buffer = (buffer << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function totpCodeAt(secretBase32: string, now: Date): string {
  const key = base32Decode(secretBase32);
  const step = Math.floor(now.getTime() / 30_000);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

const pem = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../certs/rds-ap-southeast-2-bundle.pem"),
  "utf8",
);

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/test/.runtime.json",
);

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: Role): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

const runtimeState = loadRuntime();
const appSql = createPlaintextAppSql(roleUrl(runtimeState, "app"));
const identitySql = createPlaintextIdentitySql(roleUrl(runtimeState, "identity"));
const platformSql = createPlaintextPlatformSql(roleUrl(runtimeState, "platform"));
const directSql = createPlaintextDirectSql(runtimeState.productOnlyUrl);

function checkout(role: Role, run: (sql: never) => Promise<unknown>): Promise<unknown> {
  const db = role === "app" ? appSql : role === "identity" ? identitySql : platformSql;
  return run(db as never);
}

class MemoryMail implements OtpMail {
  last: { to: string; code: string } | undefined;
  send(input: { to: string; code: string }): Promise<void> {
    this.last = input;
    return Promise.resolve();
  }
}

class MemoryNotice implements SecondFactorNotice {
  sent: { to: string; kind: SecondFactorNoticeKind }[] = [];
  async send(input: { to: string; kind: SecondFactorNoticeKind }): Promise<void> {
    this.sent.push(input);
  }
}

class MemoryInviteMail implements InvitationMail {
  last: { to: string; communitySlug: string; link: string; expiresAt: Date } | undefined;
  async send(input: {
    to: string;
    communitySlug: string;
    link: string;
    expiresAt: Date;
  }): Promise<void> {
    this.last = input;
  }
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function bytesFrom(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function clientData(type: string, challenge: Uint8Array, origin = ADMIN_ORIGIN): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type,
      challenge: b64(challenge),
      origin,
    }),
  );
}

function coseKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  return encodeCbor(
    new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
}

function authenticatorData(input: {
  rpId?: string;
  flags?: number;
  signCount: number;
  credentialId?: Uint8Array;
  cose?: Uint8Array;
}): Uint8Array {
  const rpIdHash = new Uint8Array(
    createHash("sha256")
      .update(input.rpId ?? ADMIN_RP_ID)
      .digest(),
  );
  const attested = input.credentialId !== undefined && input.cose !== undefined;
  const flags = input.flags ?? (attested ? 0x45 : 0x05);
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, input.signCount);
  const parts = [rpIdHash, Uint8Array.of(flags), count];
  if (attested && input.credentialId && input.cose) {
    const length = new Uint8Array(2);
    new DataView(length.buffer).setUint16(0, input.credentialId.byteLength);
    parts.push(
      new Uint8Array(16),
      length,
      new Uint8Array(input.credentialId),
      new Uint8Array(input.cose),
    );
  }
  return concat(parts);
}

async function signer() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    x: new Uint8Array(Buffer.from(jwk.x ?? "", "base64url")),
    y: new Uint8Array(Buffer.from(jwk.y ?? "", "base64url")),
    sign: (data: Uint8Array) =>
      new Uint8Array(signDer("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "der" })),
  };
}

function makePasskeyAttestation(
  challenge: Uint8Array,
  credentialId: Uint8Array,
  key: Awaited<ReturnType<typeof signer>>,
  rpId = ADMIN_RP_ID,
  origin = ADMIN_ORIGIN,
  flags = 0x45,
) {
  return {
    clientDataJSON: b64(clientData("webauthn.create", challenge, origin)),
    attestationObject: b64(
      encodeCbor(
        new Map<Cbor, Cbor>([
          ["fmt", "none"],
          ["attStmt", new Map<Cbor, Cbor>()],
          [
            "authData",
            authenticatorData({
              rpId,
              flags,
              signCount: 0,
              credentialId,
              cose: coseKey(key.x, key.y),
            }),
          ],
        ]),
      ),
    ),
  };
}

function makePasskeyAssertion(
  challenge: Uint8Array,
  credentialId: Uint8Array,
  key: Awaited<ReturnType<typeof signer>>,
  signCount: number,
  rpId = ADMIN_RP_ID,
  origin = ADMIN_ORIGIN,
  flags = 0x05,
) {
  const authData = authenticatorData({ rpId, flags, signCount });
  const client = clientData("webauthn.get", challenge, origin);
  const clientHash = new Uint8Array(createHash("sha256").update(client).digest());
  return {
    credentialId: b64(credentialId),
    clientDataJSON: b64(client),
    authenticatorData: b64(authData),
    signature: b64(key.sign(concat([authData, clientHash]))),
  };
}

function envFor(port: number, adminOrigin?: string): ServiceEnv {
  const read = readServiceEnv(
    {
      PORT: String(port),
      PGPORT: "5432",
      AWS_REGION: "ap-southeast-2",
      NODE_ENV: "test",
      COMMUNITY_HUB_ENVIRONMENT: "staging",
      API_HOSTNAME,
      AUTH_HOSTNAME,
      WEBHOOKS_HOSTNAME: "webhooks.au.example.test",
      OPS_HOSTNAME: "ops.au.example.test",
      PGHOST: "127.0.0.1",
      PGDATABASE: "hub_product_only",
      PGUSER_APP: "app",
      PGUSER_IDENTITY: "identity",
      PGUSER_PLATFORM: "platform",
      PGPASSWORD_APP: runtimeState.passwords.app,
      PGPASSWORD_IDENTITY: runtimeState.passwords.identity,
      PGPASSWORD_PLATFORM: runtimeState.passwords.platform,
      ENVELOPE_KEY_ARN: KEY_ARN,
      APP_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:app",
      IDENTITY_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity",
      PLATFORM_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:platform",
      ...(adminOrigin !== undefined ? { ADMIN_ORIGIN: adminOrigin } : {}),
    },
    pem,
  );
  if (!read.ok) {
    throw new Error("synthetic env");
  }
  return read.env;
}

function makeHarness(options: { adminOrigin?: string | undefined; now?: () => Date } = {}) {
  const mail = new MemoryMail();
  const notice = new MemoryNotice();
  const logs: { message: string; fields: Record<string, unknown> }[] = [];
  let currentNow = new Date(Math.floor(Date.now() / 30_000) * 30_000);
  const now = options.now ?? (() => currentNow);
  const kms = createLocalKmsPort();
  const deps: AuthDeps = {
    checkout: checkout as AuthDeps["checkout"],
    kms,
    keyArn: KEY_ARN,
    mail,
    notice,
    now,
    authHostname: AUTH_HOSTNAME,
    adminOrigin: options.adminOrigin,
    log: (message, fields) => {
      logs.push({ message, fields });
    },
  };
  const routes = [...authRoutes(deps), ...secondFactorRoutes(deps)];

  async function call(
    method: "GET" | "POST",
    pattern: string,
    body?: unknown,
    authorization?: string,
    hostname = AUTH_HOSTNAME,
  ): Promise<Response> {
    const found = routes.find((r) => r.method === method && r.pattern === pattern);
    if (found === undefined) {
      throw new Error(`missing route ${method} ${pattern}`);
    }
    const headers = new Headers({ "x-community-hub-hostname": hostname });
    if (authorization !== undefined) {
      headers.set("authorization", authorization);
    }
    const init: RequestInit = { method, headers };
    if (method === "POST") {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body ?? {});
    }
    return withRequest({ requestId: REQUEST_ID }, () =>
      Promise.resolve(
        found.handle(new Request(`http://127.0.0.1${pattern}`, init), {
          billing: found.billing,
          pattern: found.pattern,
        }),
      ),
    );
  }

  return {
    kms,
    mail,
    notice,
    logs,
    routes,
    setNow: (next: Date) => {
      currentNow = next;
    },
    advanceMs: (ms: number) => {
      currentNow = new Date(currentNow.getTime() + ms);
      return currentNow;
    },
    call,
  };
}

async function cleanIdentity(): Promise<void> {
  await directSql`delete from identity.second_factor_events`;
  await identitySql`delete from identity.backup_codes`;
  await identitySql`delete from identity.totp_credentials`;
  await identitySql`delete from identity.sessions`;
  await identitySql`delete from identity.passkey_credentials`;
  await identitySql`delete from identity.passkey_challenges`;
  await identitySql`delete from identity.otp_challenges`;
  await identitySql`delete from identity.invitation_emails`;
  await identitySql`delete from identity.users`;
  await identitySql`delete from identity.identity_keys`;
}

beforeAll(async () => {
  await applyProductMigrations(directSql);
});

afterAll(async () => {
  await cleanIdentity();
  await appSql.end({ timeout: 1 });
  await identitySql.end({ timeout: 1 });
  await platformSql.end({ timeout: 1 });
  await directSql.end({ timeout: 1 });
});

describe("second-factor HTTP routes", () => {
  it("an email-code sign-in returns a second_factor session and no refresh token", async () => {
    await cleanIdentity();
    const h = makeHarness({ adminOrigin: ADMIN_ORIGIN });
    const email = `pin87-${newId()}@example.test`;

    const startRes = await h.call("POST", "/v1/auth/email-otp/start", { email });
    expect(startRes.status).toBe(204);

    const verifyRes = await h.call("POST", "/v1/auth/email-otp/verify", {
      email,
      code: h.mail.last?.code ?? "",
    });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.headers.get("cache-control")).toBe("no-store");
    const raw = (await verifyRes.json()) as Record<string, unknown>;
    expect(raw.refreshToken).toBeUndefined();
    const parsed = verifyEmailOtpAnswer.parse(raw);
    expect(parsed.secondFactor).toBe("setup");
    expect(parsed.methods).toEqual(["totp", "passkey"]);
    expect(parsed.passkeysAvailable).toBe(true);
    expect(parsed.expiresIn).toBe(900);

    const rows = await identitySql<{ kind: string; factor: string | null }[]>`
      select kind, factor from identity.sessions
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("second_factor");
    expect(rows[0]?.factor).toBeNull();

    const listRes = await h.call(
      "GET",
      "/v1/auth/second-factor",
      undefined,
      `Bearer ${parsed.accessToken}`,
    );
    expect(listRes.status).toBe(401);
  });

  it("answers carrying a secret or backup codes are no-store", async () => {
    await cleanIdentity();
    const h = makeHarness({ adminOrigin: ADMIN_ORIGIN });
    const email = `pin88-${newId()}@example.test`;

    await h.call("POST", "/v1/auth/email-otp/start", { email });
    const vRes = await h.call("POST", "/v1/auth/email-otp/verify", {
      email,
      code: h.mail.last?.code ?? "",
    });
    const vBody = verifyEmailOtpAnswer.parse(await vRes.json());
    expect(vRes.headers.get("cache-control")).toBe("no-store");

    const startTotpRes = await h.call(
      "POST",
      "/v1/auth/second-factor/totp/start",
      {},
      `Bearer ${vBody.accessToken}`,
    );
    expect(startTotpRes.status).toBe(200);
    expect(startTotpRes.headers.get("cache-control")).toBe("no-store");
    const started = totpStartAnswer.parse(await startTotpRes.json());

    const confirmRes = await h.call(
      "POST",
      "/v1/auth/second-factor/totp/confirm",
      { code: totpCodeAt(started.secret, h.advanceMs(0)) },
      `Bearer ${vBody.accessToken}`,
    );
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.headers.get("cache-control")).toBe("no-store");
    const confirmed = firstFactorBackupCodesAnswer.parse(await confirmRes.json());

    // Sign in again with TOTP so session is fresh for backup code regeneration
    h.advanceMs(60_000);
    await h.call("POST", "/v1/auth/email-otp/start", { email });
    const v2Res = await h.call("POST", "/v1/auth/email-otp/verify", {
      email,
      code: h.mail.last?.code ?? "",
    });
    const v2Body = verifyEmailOtpAnswer.parse(await v2Res.json());
    const verifyStepRes = await h.call(
      "POST",
      "/v1/auth/second-factor/verify",
      {
        method: "totp",
        code: totpCodeAt(started.secret, h.advanceMs(0)),
      },
      `Bearer ${v2Body.accessToken}`,
    );
    expect(verifyStepRes.status).toBe(200);
    expect(verifyStepRes.headers.get("cache-control")).toBe("no-store");
    const admin = secondFactorVerifyAnswer.parse(await verifyStepRes.json());

    const regenRes = await h.call(
      "POST",
      "/v1/auth/second-factor/backup-codes",
      {},
      `Bearer ${admin.accessToken}`,
    );
    expect(regenRes.status).toBe(200);
    expect(regenRes.headers.get("cache-control")).toBe("no-store");
    const regen = regenerateBackupCodesAnswer.parse(await regenRes.json());
    expect(regen.backupCodes).toHaveLength(10);
    expect(confirmed.backupCodes).toHaveLength(10);
  });

  it("refusals have empty bodies", async () => {
    await cleanIdentity();
    const h = makeHarness({ adminOrigin: ADMIN_ORIGIN });
    const email = `pin89-${newId()}@example.test`;

    await h.call("POST", "/v1/auth/email-otp/start", { email });
    const badOtp = await h.call("POST", "/v1/auth/email-otp/verify", {
      email,
      code: "99999999",
    });
    expect(badOtp.status).toBe(401);
    expect(await badOtp.text()).toBe("");

    await h.call("POST", "/v1/auth/email-otp/start", { email });
    const okOtp = await h.call("POST", "/v1/auth/email-otp/verify", {
      email,
      code: h.mail.last?.code ?? "",
    });
    const pre2fa = verifyEmailOtpAnswer.parse(await okOtp.json());

    const badBody = await h.call(
      "POST",
      "/v1/auth/second-factor/totp/confirm",
      { code: "123456", extra: 1 },
      `Bearer ${pre2fa.accessToken}`,
    );
    expect(badBody.status).toBe(400);
    expect(await badBody.text()).toBe("");

    const unauthSec = await h.call(
      "GET",
      "/v1/auth/second-factor",
      undefined,
      `Bearer ${pre2fa.accessToken}`,
    );
    expect(unauthSec.status).toBe(401);
    expect(await unauthSec.text()).toBe("");

    const wrongStep = await h.call(
      "POST",
      "/v1/auth/second-factor/verify",
      { method: "totp", code: "000000" },
      `Bearer ${pre2fa.accessToken}`,
    );
    expect(wrongStep.status).toBe(401);
    expect(await wrongStep.text()).toBe("");
  });

  it("no code, secret, otpauth link or email reaches the logs when a second-factor route fails", async () => {
    await cleanIdentity();
    const h = makeHarness({ adminOrigin: ADMIN_ORIGIN });
    const consoleLines: string[] = [];
    const originalLog = console.log;
    console.log = (line: unknown) => {
      consoleLines.push(String(line));
    };

    try {
      const email = `pin90-${newId()}@example.test`;
      await h.call("POST", "/v1/auth/email-otp/start", { email });
      const emailCode = h.mail.last?.code ?? "";
      const vRes = await h.call("POST", "/v1/auth/email-otp/verify", {
        email,
        code: emailCode,
      });
      const pre2fa = verifyEmailOtpAnswer.parse(await vRes.json());

      const startRes = await h.call(
        "POST",
        "/v1/auth/second-factor/totp/start",
        {},
        `Bearer ${pre2fa.accessToken}`,
      );
      const started = totpStartAnswer.parse(await startRes.json());

      const wrongConfirmCode = "765432";
      const badConfirm = await h.call(
        "POST",
        "/v1/auth/second-factor/totp/confirm",
        { code: wrongConfirmCode },
        `Bearer ${pre2fa.accessToken}`,
      );
      expect(badConfirm.status).toBe(401);

      const goodConfirmCode = totpCodeAt(started.secret, h.advanceMs(0));
      const confirmRes = await h.call(
        "POST",
        "/v1/auth/second-factor/totp/confirm",
        { code: goodConfirmCode },
        `Bearer ${pre2fa.accessToken}`,
      );
      expect(confirmRes.status).toBe(200);

      h.advanceMs(60_000);
      await h.call("POST", "/v1/auth/email-otp/start", { email });
      const secondEmailCode = h.mail.last?.code ?? "";
      const v2Res = await h.call("POST", "/v1/auth/email-otp/verify", {
        email,
        code: secondEmailCode,
      });
      const v2 = verifyEmailOtpAnswer.parse(await v2Res.json());

      const wrongStepCode = "876543";
      const failStep = await h.call(
        "POST",
        "/v1/auth/second-factor/verify",
        { method: "totp", code: wrongStepCode },
        `Bearer ${v2.accessToken}`,
      );
      expect(failStep.status).toBe(401);

      const serialized = JSON.stringify({ logs: h.logs, consoleLines });
      for (const secret of [
        email,
        emailCode,
        secondEmailCode,
        started.secret,
        started.otpauthUri,
        wrongConfirmCode,
        goodConfirmCode,
        wrongStepCode,
        "otpauth://",
      ]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      console.log = originalLog;
    }
  });

  it("tenant passkey routes answer 404 without ADMIN_ORIGIN", async () => {
    await cleanIdentity();
    const h = makeHarness({ adminOrigin: undefined });
    const email = `pin91-${newId()}@example.test`;
    await h.call("POST", "/v1/auth/email-otp/start", { email });
    const vRes = await h.call("POST", "/v1/auth/email-otp/verify", {
      email,
      code: h.mail.last?.code ?? "",
    });
    const pre2fa = verifyEmailOtpAnswer.parse(await vRes.json());

    const passkeyRoutes: [string, unknown][] = [
      ["/v1/auth/passkey/register/options", {}],
      ["/v1/auth/passkey/register/verify", { clientDataJSON: "YQ", attestationObject: "YQ" }],
      ["/v1/auth/passkey/authenticate/options", {}],
      [
        "/v1/auth/passkey/authenticate/verify",
        { credentialId: "YQ", clientDataJSON: "YQ", authenticatorData: "YQ", signature: "YQ" },
      ],
      ["/v1/auth/second-factor/passkey/options", {}],
      [
        "/v1/auth/second-factor/passkey/verify",
        { credentialId: "YQ", clientDataJSON: "YQ", authenticatorData: "YQ", signature: "YQ" },
      ],
      ["/v1/auth/second-factor/fresh/passkey/options", {}],
      [
        "/v1/auth/second-factor/fresh/passkey/verify",
        { credentialId: "YQ", clientDataJSON: "YQ", authenticatorData: "YQ", signature: "YQ" },
      ],
    ];

    for (const [pattern, body] of passkeyRoutes) {
      const res = await h.call("POST", pattern, body, `Bearer ${pre2fa.accessToken}`);
      expect(res.status, `expected 404 on ${pattern} without ADMIN_ORIGIN`).toBe(404);
      expect(await res.text()).toBe("");
    }
  });

  it("Security routes refuse a second_factor token", async () => {
    await cleanIdentity();
    const h = makeHarness({ adminOrigin: ADMIN_ORIGIN });
    const email = `pin92-${newId()}@example.test`;
    await h.call("POST", "/v1/auth/email-otp/start", { email });
    const vRes = await h.call("POST", "/v1/auth/email-otp/verify", {
      email,
      code: h.mail.last?.code ?? "",
    });
    const pre2fa = verifyEmailOtpAnswer.parse(await vRes.json());
    const auth = `Bearer ${pre2fa.accessToken}`;

    const calls: ["GET" | "POST", string, unknown?][] = [
      ["GET", "/v1/auth/second-factor", undefined],
      ["POST", "/v1/auth/second-factor/fresh", { code: "123456" }],
      ["POST", "/v1/auth/second-factor/fresh/passkey/options", {}],
      [
        "POST",
        "/v1/auth/second-factor/fresh/passkey/verify",
        { credentialId: "YQ", clientDataJSON: "YQ", authenticatorData: "YQ", signature: "YQ" },
      ],
      ["POST", "/v1/auth/second-factor/totp/remove", {}],
      [
        "POST",
        "/v1/auth/second-factor/passkeys/remove",
        { passkeyId: "00000000-0000-4000-8000-000000000001" },
      ],
      ["POST", "/v1/auth/second-factor/backup-codes", {}],
    ];

    for (const [method, pattern, body] of calls) {
      const res = await h.call(method, pattern, body, auth);
      expect(res.status, `expected 401 on ${method} ${pattern}`).toBe(401);
      expect(await res.text()).toBe("");
    }
  });

  it("the passkey routes use the admin origin's host as rp id", async () => {
    await cleanIdentity();
    const h = makeHarness({ adminOrigin: ADMIN_ORIGIN });
    const email = `pin94-${newId()}@example.test`;

    await h.call("POST", "/v1/auth/email-otp/start", { email });
    const v1 = verifyEmailOtpAnswer.parse(
      await (
        await h.call("POST", "/v1/auth/email-otp/verify", {
          email,
          code: h.mail.last?.code ?? "",
        })
      ).json(),
    );

    const regOptsRes = await h.call(
      "POST",
      "/v1/auth/passkey/register/options",
      {},
      `Bearer ${v1.accessToken}`,
    );
    expect(regOptsRes.status).toBe(200);
    const regOpts = passkeyRegisterOptionsAnswer.parse(await regOptsRes.json());
    expect(regOpts.rp.id).toBe(ADMIN_RP_ID);
    expect(regOpts.authenticatorSelection.userVerification).toBe("required");

    const key = await signer();
    const credId = new Uint8Array(16).fill(9);
    const regVerifyRes = await h.call(
      "POST",
      "/v1/auth/passkey/register/verify",
      makePasskeyAttestation(bytesFrom(regOpts.challenge), credId, key),
      `Bearer ${v1.accessToken}`,
    );
    expect(regVerifyRes.status).toBe(200);
    const regBody = firstFactorBackupCodesAnswer.parse(await regVerifyRes.json());
    expect(regBody.backupCodes).toHaveLength(10);

    const authOptsRes = await h.call("POST", "/v1/auth/passkey/authenticate/options", {});
    expect(authOptsRes.status).toBe(200);
    const authOpts = passkeyAuthenticateOptionsAnswer.parse(await authOptsRes.json());
    expect(authOpts.rpId).toBe(ADMIN_RP_ID);
    expect(authOpts.userVerification).toBe("required");

    await h.call("POST", "/v1/auth/email-otp/start", { email });
    const v2 = verifyEmailOtpAnswer.parse(
      await (
        await h.call("POST", "/v1/auth/email-otp/verify", {
          email,
          code: h.mail.last?.code ?? "",
        })
      ).json(),
    );
    const sfOptsRes = await h.call(
      "POST",
      "/v1/auth/second-factor/passkey/options",
      {},
      `Bearer ${v2.accessToken}`,
    );
    expect(sfOptsRes.status).toBe(200);
    const sfOpts = passkeyAuthenticateOptionsAnswer.parse(await sfOptsRes.json());
    expect(sfOpts.rpId).toBe(ADMIN_RP_ID);

    const sfVerifyRes = await h.call(
      "POST",
      "/v1/auth/second-factor/passkey/verify",
      makePasskeyAssertion(bytesFrom(sfOpts.challenge), credId, key, 1),
      `Bearer ${v2.accessToken}`,
    );
    expect(sfVerifyRes.status).toBe(200);
    const admin = secondFactorVerifyAnswer.parse(await sfVerifyRes.json());

    const freshOptsRes = await h.call(
      "POST",
      "/v1/auth/second-factor/fresh/passkey/options",
      {},
      `Bearer ${admin.accessToken}`,
    );
    expect(freshOptsRes.status).toBe(200);
    const freshOpts = passkeyAuthenticateOptionsAnswer.parse(await freshOptsRes.json());
    expect(freshOpts.rpId).toBe(ADMIN_RP_ID);
  });

  it("verify reports passkeys unavailable without ADMIN_ORIGIN", async () => {
    await cleanIdentity();
    const h = makeHarness({ adminOrigin: undefined });
    const email = `pin95-${newId()}@example.test`;

    await h.call("POST", "/v1/auth/email-otp/start", { email });
    const setupRes = await h.call("POST", "/v1/auth/email-otp/verify", {
      email,
      code: h.mail.last?.code ?? "",
    });
    expect(setupRes.status).toBe(200);
    const setupBody = verifyEmailOtpAnswer.parse(await setupRes.json());
    expect(setupBody.secondFactor).toBe("setup");
    expect(setupBody.methods).toEqual(["totp"]);
    expect(setupBody.passkeysAvailable).toBe(false);

    const started = totpStartAnswer.parse(
      await (
        await h.call(
          "POST",
          "/v1/auth/second-factor/totp/start",
          {},
          `Bearer ${setupBody.accessToken}`,
        )
      ).json(),
    );
    const confirmed = await h.call(
      "POST",
      "/v1/auth/second-factor/totp/confirm",
      { code: totpCodeAt(started.secret, h.advanceMs(0)) },
      `Bearer ${setupBody.accessToken}`,
    );
    expect(confirmed.status).toBe(200);

    h.advanceMs(60_000);
    await h.call("POST", "/v1/auth/email-otp/start", { email });
    const verifyRes = await h.call("POST", "/v1/auth/email-otp/verify", {
      email,
      code: h.mail.last?.code ?? "",
    });
    expect(verifyRes.status).toBe(200);
    const verifyBody = verifyEmailOtpAnswer.parse(await verifyRes.json());
    expect(verifyBody.secondFactor).toBe("verify");
    expect(verifyBody.methods).toEqual(["totp", "backup_code"]);
    expect(verifyBody.passkeysAvailable).toBe(false);
  });

  it("a refreshed admin session keeps the factor of its second step", async () => {
    await cleanIdentity();
    const h = makeHarness({ adminOrigin: ADMIN_ORIGIN });
    const email = `refresh-${newId()}@example.test`;

    // First sign-in: set up an authenticator app.
    await h.call("POST", "/v1/auth/email-otp/start", { email });
    const setupSession = verifyEmailOtpAnswer.parse(
      await (
        await h.call("POST", "/v1/auth/email-otp/verify", {
          email,
          code: h.mail.last?.code ?? "",
        })
      ).json(),
    );
    const started = totpStartAnswer.parse(
      await (
        await h.call(
          "POST",
          "/v1/auth/second-factor/totp/start",
          {},
          `Bearer ${setupSession.accessToken}`,
        )
      ).json(),
    );
    const confirmed = await h.call(
      "POST",
      "/v1/auth/second-factor/totp/confirm",
      { code: totpCodeAt(started.secret, h.advanceMs(0)) },
      `Bearer ${setupSession.accessToken}`,
    );
    expect(confirmed.status).toBe(200);

    // Second sign-in: the email code gives a pre-2FA session, the second step by TOTP an admin session.
    h.advanceMs(60_000);
    await h.call("POST", "/v1/auth/email-otp/start", { email });
    const pre2fa = verifyEmailOtpAnswer.parse(
      await (
        await h.call("POST", "/v1/auth/email-otp/verify", {
          email,
          code: h.mail.last?.code ?? "",
        })
      ).json(),
    );
    expect(pre2fa.secondFactor).toBe("verify");
    const admin = secondFactorVerifyAnswer.parse(
      await (
        await h.call(
          "POST",
          "/v1/auth/second-factor/verify",
          { method: "totp", code: totpCodeAt(started.secret, h.advanceMs(0)) },
          `Bearer ${pre2fa.accessToken}`,
        )
      ).json(),
    );

    const refreshedRes = await h.call("POST", "/v1/auth/session/refresh", {
      refreshToken: admin.refreshToken,
    });
    expect(refreshedRes.status).toBe(200);
    const refreshed = adminSessionAnswer.parse(await refreshedRes.json());
    expect(refreshed.refreshToken).not.toBe(admin.refreshToken);

    // The refreshed session still reaches a route that needs a tenant session with a factor.
    const listed = await h.call(
      "GET",
      "/v1/auth/second-factor",
      undefined,
      `Bearer ${refreshed.accessToken}`,
    );
    expect(listed.status).toBe(200);
    expect(secondFactorListAnswer.parse(await listed.json()).totp).not.toBeNull();

    const live = await identitySql<{ kind: string; factor: string | null }[]>`
      select kind, factor from identity.sessions where revoked_at is null and kind = 'tenant'
    `;
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((row) => row.factor === "otp_totp")).toBe(true);
  });

  it("completes backup-code recovery window, passkey sign-in, Security management, and invitation acceptance", async () => {
    await cleanIdentity();
    const h = makeHarness({ adminOrigin: ADMIN_ORIGIN });
    const ownerEmail = `owner-${newId()}@example.test`;

    // 1. Setup TOTP -> get backup codes + admin session
    await h.call("POST", "/v1/auth/email-otp/start", { email: ownerEmail });
    const s1 = verifyEmailOtpAnswer.parse(
      await (
        await h.call("POST", "/v1/auth/email-otp/verify", {
          email: ownerEmail,
          code: h.mail.last?.code ?? "",
        })
      ).json(),
    );
    const started = totpStartAnswer.parse(
      await (
        await h.call("POST", "/v1/auth/second-factor/totp/start", {}, `Bearer ${s1.accessToken}`)
      ).json(),
    );
    const confirm1 = firstFactorBackupCodesAnswer.parse(
      await (
        await h.call(
          "POST",
          "/v1/auth/second-factor/totp/confirm",
          { code: totpCodeAt(started.secret, h.advanceMs(0)) },
          `Bearer ${s1.accessToken}`,
        )
      ).json(),
    );
    expect(h.notice.sent.map((x) => x.kind)).toEqual(["totp_set_up"]);

    // 2. First setup is not fresh -> add/remove refused until fresh check
    const stalePasskeyOpts = await h.call(
      "POST",
      "/v1/auth/passkey/register/options",
      {},
      `Bearer ${confirm1.accessToken}`,
    );
    expect(stalePasskeyOpts.status).toBe(401);

    h.advanceMs(31_000);
    const freshCheck = await h.call(
      "POST",
      "/v1/auth/second-factor/fresh",
      { code: totpCodeAt(started.secret, h.advanceMs(0)) },
      `Bearer ${confirm1.accessToken}`,
    );
    expect(freshCheck.status).toBe(204);

    // 3. Add a passkey while fresh
    const pkRegOpts = (await (
      await h.call(
        "POST",
        "/v1/auth/passkey/register/options",
        {},
        `Bearer ${confirm1.accessToken}`,
      )
    ).json()) as { challenge: string };
    const key = await signer();
    const credId = new Uint8Array(16).fill(12);
    const pkRegVerify = await h.call(
      "POST",
      "/v1/auth/passkey/register/verify",
      makePasskeyAttestation(bytesFrom(pkRegOpts.challenge), credId, key),
      `Bearer ${confirm1.accessToken}`,
    );
    expect(pkRegVerify.status).toBe(204);

    // 4. List Security factors (never includes secret)
    const listed = secondFactorListAnswer.parse(
      await (
        await h.call("GET", "/v1/auth/second-factor", undefined, `Bearer ${confirm1.accessToken}`)
      ).json(),
    );
    expect(listed.totp).not.toBeNull();
    expect(listed.passkeys).toHaveLength(1);
    expect(listed.backupCodesLeft).toBe(10);
    expect(listed.freshUntil).not.toBeNull();

    // 5. Passkey sign-in directly produces an admin session
    const pkAuthOpts = passkeyAuthenticateOptionsAnswer.parse(
      await (await h.call("POST", "/v1/auth/passkey/authenticate/options", {})).json(),
    );
    const pkSignedIn = secondFactorVerifyAnswer.parse(
      await (
        await h.call(
          "POST",
          "/v1/auth/passkey/authenticate/verify",
          makePasskeyAssertion(bytesFrom(pkAuthOpts.challenge), credId, key, 1),
        )
      ).json(),
    );
    expect(pkSignedIn.userId).toBe(confirm1.userId);

    // 6. Backup-code second step opens recovery window
    await h.call("POST", "/v1/auth/email-otp/start", { email: ownerEmail });
    const s2 = verifyEmailOtpAnswer.parse(
      await (
        await h.call("POST", "/v1/auth/email-otp/verify", {
          email: ownerEmail,
          code: h.mail.last?.code ?? "",
        })
      ).json(),
    );
    expect(s2.secondFactor).toBe("verify");
    expect(s2.methods).toEqual(["totp", "passkey", "backup_code"]);

    const recoveryRes = await h.call(
      "POST",
      "/v1/auth/second-factor/verify",
      { method: "backup_code", code: confirm1.backupCodes[0]! },
      `Bearer ${s2.accessToken}`,
    );
    expect(recoveryRes.status).toBe(200);
    const recovery = secondFactorVerifyAnswer.parse(await recoveryRes.json());
    expect(recovery.backupCodesLeft).toBe(9);

    // Recovery cannot pass fresh check or remove TOTP, but can regenerate backup codes
    const recoveryFresh = await h.call(
      "POST",
      "/v1/auth/second-factor/fresh",
      { code: totpCodeAt(started.secret, h.advanceMs(31_000)) },
      `Bearer ${recovery.accessToken}`,
    );
    expect(recoveryFresh.status).toBe(401);

    const recoveryRemoveTotp = await h.call(
      "POST",
      "/v1/auth/second-factor/totp/remove",
      {},
      `Bearer ${recovery.accessToken}`,
    );
    expect(recoveryRemoveTotp.status).toBe(401);

    const regenRes = await h.call(
      "POST",
      "/v1/auth/second-factor/backup-codes",
      {},
      `Bearer ${recovery.accessToken}`,
    );
    expect(regenRes.status).toBe(200);

    // 7. Invited user accepts invitation after completing second-factor setup
    const orgId = newId();
    const communityId = newId();
    const communitySlug = `sf-inv-${orgId.slice(0, 8)}`;
    const inviteMail = new MemoryInviteMail();
    const server = startServer({
      env: envFor(18495, ADMIN_ORIGIN),
      routes: [
        ...h.routes,
        ...accessRoutes({
          checkout: checkout as AuthDeps["checkout"],
          kms: h.kms,
          keyArn: KEY_ARN,
          now: () => h.advanceMs(0),
          apiHostname: API_HOSTNAME,
          log: () => undefined,
          guardLog: () => undefined,
        }),
        ...invitationRoutes({
          checkout: checkout as AuthDeps["checkout"],
          kms: h.kms,
          keyArn: KEY_ARN,
          now: () => h.advanceMs(0),
          apiHostname: API_HOSTNAME,
          adminOrigin: ADMIN_ORIGIN,
          mail: inviteMail,
          log: () => undefined,
          guardLog: () => undefined,
        }),
      ],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        if (server.listening) {
          resolve();
          return;
        }
        server.once("listening", () => resolve());
        server.once("error", reject);
      });

      await platformSql.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${orgId}, ${communitySlug}, 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${orgId}, ${communitySlug}, 'au')
        `;
      });
      const planKey = `plan_${orgId.slice(0, 8)}`;
      await upsertPlan(platformSql, {
        key: planKey,
        entitlements: [{ key: "people.directory", limit: null }],
      });
      await assignPlan(platformSql, {
        organisationId: orgId,
        planKey,
        now: h.advanceMs(0),
      });
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(appSql, { orgId, communityId }, async (tx) => {
          await bootstrapOwner(tx, {
            now: h.advanceMs(0),
            userId: confirm1.userId,
            actorUserId: confirm1.userId,
          });
          await createPerson(tx, h.kms, KEY_ARN, {
            now: h.advanceMs(0),
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Grace",
            familyName: "Hopper",
            email: `invitee-${orgId.slice(0, 8)}@example.test`,
            phone: null,
            actorUserId: confirm1.userId,
          });
        }),
      );

      // Fresh sign-in by passkey for owner so session isn't revoked by recovery regen above
      const pkAuth2 = passkeyAuthenticateOptionsAnswer.parse(
        await (
          await fetch("http://127.0.0.1:18495/v1/auth/passkey/authenticate/options", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-community-hub-hostname": AUTH_HOSTNAME,
            },
            body: "{}",
          })
        ).json(),
      );
      const ownerAdmin = secondFactorVerifyAnswer.parse(
        await (
          await fetch("http://127.0.0.1:18495/v1/auth/passkey/authenticate/verify", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-community-hub-hostname": AUTH_HOSTNAME,
            },
            body: JSON.stringify(
              makePasskeyAssertion(bytesFrom(pkAuth2.challenge), credId, key, 2),
            ),
          })
        ).json(),
      );

      const inviteeEmail = `invitee-${orgId.slice(0, 8)}@example.test`;
      const createdInv = await fetch("http://127.0.0.1:18495/v1/access/invitations/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-community-hub-hostname": API_HOSTNAME,
          authorization: `Bearer ${ownerAdmin.accessToken}`,
        },
        body: JSON.stringify({ communitySlug, email: inviteeEmail, roleKey: "member" }),
      });
      expect(createdInv.status).toBe(201);
      const link = inviteMail.last?.link ?? "";
      const marker = "#invite=";
      const at = link.lastIndexOf(marker);
      expect(at).toBeGreaterThanOrEqual(0);
      const invToken = link.slice(at + marker.length);

      // Invitee starts email OTP and gets pre-2FA session
      await fetch("http://127.0.0.1:18495/v1/auth/email-otp/start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-community-hub-hostname": AUTH_HOSTNAME,
        },
        body: JSON.stringify({ email: inviteeEmail }),
      });
      const invVerify = verifyEmailOtpAnswer.parse(
        await (
          await fetch("http://127.0.0.1:18495/v1/auth/email-otp/verify", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-community-hub-hostname": AUTH_HOSTNAME,
            },
            body: JSON.stringify({ email: inviteeEmail, code: h.mail.last?.code ?? "" }),
          })
        ).json(),
      );

      // Accepting with pre-2FA token is refused (401)
      const acceptPre = await fetch("http://127.0.0.1:18495/v1/invitations/accept", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-community-hub-hostname": API_HOSTNAME,
          authorization: `Bearer ${invVerify.accessToken}`,
        },
        body: JSON.stringify({ token: invToken }),
      });
      expect(acceptPre.status).toBe(401);

      // Invitee completes first-factor setup
      const invStart = totpStartAnswer.parse(
        await (
          await fetch("http://127.0.0.1:18495/v1/auth/second-factor/totp/start", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-community-hub-hostname": AUTH_HOSTNAME,
              authorization: `Bearer ${invVerify.accessToken}`,
            },
            body: "{}",
          })
        ).json(),
      );
      const invAdmin = firstFactorBackupCodesAnswer.parse(
        await (
          await fetch("http://127.0.0.1:18495/v1/auth/second-factor/totp/confirm", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-community-hub-hostname": AUTH_HOSTNAME,
              authorization: `Bearer ${invVerify.accessToken}`,
            },
            body: JSON.stringify({ code: totpCodeAt(invStart.secret, h.advanceMs(0)) }),
          })
        ).json(),
      );

      // Accepting with full admin token succeeds (200)
      const acceptAdmin = await fetch("http://127.0.0.1:18495/v1/invitations/accept", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-community-hub-hostname": API_HOSTNAME,
          authorization: `Bearer ${invAdmin.accessToken}`,
        },
        body: JSON.stringify({ token: invToken }),
      });
      expect(acceptAdmin.status).toBe(200);
      expect(await acceptAdmin.json()).toEqual({ communitySlug });

      // Remove TOTP (requires fresh check since first setup is not fresh, and must leave passkey)
      h.advanceMs(31_000);
      const rmTotp = await h.call(
        "POST",
        "/v1/auth/second-factor/totp/remove",
        {},
        `Bearer ${ownerAdmin.accessToken}`,
      );
      expect(rmTotp.status).toBe(204);
      const afterRemove = secondFactorListAnswer.parse(
        await (
          await h.call(
            "GET",
            "/v1/auth/second-factor",
            undefined,
            `Bearer ${ownerAdmin.accessToken}`,
          )
        ).json(),
      );
      expect(afterRemove.totp).toBeNull();
      expect(afterRemove.passkeys).toHaveLength(1);

      // Removing the last remaining factor (passkey) is refused
      const rmLastPasskey = await h.call(
        "POST",
        "/v1/auth/second-factor/passkeys/remove",
        { passkeyId: afterRemove.passkeys[0]!.id },
        `Bearer ${ownerAdmin.accessToken}`,
      );
      expect(rmLastPasskey.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await platformSql`delete from platform.community_allocations where community_id = ${communityId}::uuid`;
      await platformSql`delete from platform.organisation_plans where organisation_id = ${orgId}::uuid`;
      await platformSql`delete from platform.communities where organisation_id = ${orgId}::uuid`;
      await platformSql`delete from platform.organisations where id = ${orgId}::uuid`;
    }
  });
});
