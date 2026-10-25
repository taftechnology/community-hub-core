import { createHash, generateKeyPairSync, sign as signDer } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations } from "@community-hub/db";
import {
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import {
  beginOperatorAuthentication,
  findOrCreateUserByEmail,
  finishOperatorAuthentication,
  grantOperator,
  type OtpMail,
} from "@community-hub/identity";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Checkout } from "./checkout.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { opsRoutes } from "./ops-routes.js";
import { startServer } from "./server.js";
import { encodeCbor, type Cbor } from "../../../modules/core/identity/domain/cbor.js";

type DirectSql = ReturnType<typeof createPlaintextDirectSql>;
type IdentitySql = ReturnType<typeof createPlaintextIdentitySql>;
type PlatformSql = ReturnType<typeof createPlaintextPlatformSql>;
type AnySql = Parameters<typeof grantOperator>[0];

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const OPS_HOSTNAME = "ops.example.test";
const RP_ID = OPS_HOSTNAME;
const ORIGIN = `https://${OPS_HOSTNAME}`;
const PORT = 18473;
const ENROLMENT_CODE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

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

function roleUrl(runtime: Runtime, role: "identity" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

function envFor(port: number): ServiceEnv {
  const read = readServiceEnv(
    {
      PORT: String(port),
      PGPORT: "5432",
      AWS_REGION: "ap-southeast-2",
      NODE_ENV: "test",
      COMMUNITY_HUB_ENVIRONMENT: "staging",
      API_HOSTNAME: "api.example.test",
      AUTH_HOSTNAME: "auth.example.test",
      WEBHOOKS_HOSTNAME: "webhooks.example.test",
      OPS_HOSTNAME,
      PGHOST: "127.0.0.1",
      PGDATABASE: "hub_product_only",
      PGUSER_APP: "app",
      PGUSER_IDENTITY: "identity",
      PGUSER_PLATFORM: "platform",
      PGPASSWORD_APP: "pw-app",
      PGPASSWORD_IDENTITY: "pw-identity",
      PGPASSWORD_PLATFORM: "pw-platform",
      ENVELOPE_KEY_ARN: KEY_ARN,
      APP_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:app",
      IDENTITY_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity",
      PLATFORM_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:platform",
    },
    pem,
  );
  if (!read.ok) {
    throw new Error("synthetic env failed");
  }
  return read.env;
}

class MemoryMail implements OtpMail {
  last: { to: string; code: string } | undefined;

  send(input: { to: string; code: string }): Promise<void> {
    this.last = input;
    return Promise.resolve();
  }
}

class TestMail implements OtpMail {
  readonly memory = new MemoryMail();
  activeHandler?: ((input: { to: string; code: string }) => Promise<void>) | undefined;

  get last(): { to: string; code: string } | undefined {
    return this.memory.last;
  }

  async send(input: { to: string; code: string }): Promise<void> {
    this.memory.last = input;
    if (this.activeHandler) {
      return this.activeHandler(input);
    }
    return Promise.resolve();
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

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function clientData(type: string, challenge: Uint8Array, originOverride?: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type,
      challenge: b64(challenge),
      origin: originOverride ?? ORIGIN,
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
  signCount: number;
  credentialId?: Uint8Array;
  cose?: Uint8Array;
  flags?: number;
}): Uint8Array {
  const rpIdHash = new Uint8Array(createHash("sha256").update(RP_ID).digest());
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

function attestationObject(authData: Uint8Array): Uint8Array {
  return encodeCbor(
    new Map<Cbor, Cbor>([
      ["fmt", "none"],
      ["attStmt", new Map<Cbor, Cbor>()],
      ["authData", authData],
    ]),
  );
}

async function signer(): Promise<{
  x: Uint8Array;
  y: Uint8Array;
  sign: (data: Uint8Array) => Uint8Array;
}> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    x: new Uint8Array(Buffer.from(jwk.x ?? "", "base64url")),
    y: new Uint8Array(Buffer.from(jwk.y ?? "", "base64url")),
    sign: (data) =>
      new Uint8Array(signDer("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "der" })),
  };
}

type OpsFetchOptions = {
  method?: string;
  body?: unknown;
  rawBody?: string;
  origin?: string | null | undefined;
  omitOrigin?: boolean;
  cookie?: string;
};

async function opsFetch(
  port: number,
  pathName: string,
  options: OpsFetchOptions = {},
): Promise<Response> {
  const headers = new Headers();
  headers.set("x-community-hub-hostname", OPS_HOSTNAME);
  headers.set("content-type", "application/json");

  if (!options.omitOrigin) {
    if (options.origin !== undefined) {
      if (options.origin !== null) {
        headers.set("origin", options.origin);
      }
    } else {
      headers.set("origin", ORIGIN);
    }
  }

  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }

  const body =
    options.rawBody !== undefined
      ? options.rawBody
      : options.body !== undefined
        ? typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
        : "{}";

  return fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: options.method ?? "POST",
    headers,
    body,
    signal: AbortSignal.timeout(5000),
  });
}

async function getCounts(sql: DirectSql) {
  const [otp] = await sql<{ n: number }[]>`select count(*)::int as n from identity.otp_challenges`;
  const [passkeyCh] = await sql<
    { n: number }[]
  >`select count(*)::int as n from identity.passkey_challenges`;
  const [sessions] = await sql<{ n: number }[]>`select count(*)::int as n from identity.sessions`;
  const [creds] = await sql<
    { n: number }[]
  >`select count(*)::int as n from identity.passkey_credentials`;
  const [events] = await sql<
    { n: number }[]
  >`select count(*)::int as n from identity.operator_events`;
  return {
    otp: otp?.n ?? 0,
    passkeyChallenges: passkeyCh?.n ?? 0,
    sessions: sessions?.n ?? 0,
    passkeyCredentials: creds?.n ?? 0,
    events: events?.n ?? 0,
  };
}

async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Poll timed out after 5000ms: ${message}`);
}

describe("ops flow integration", () => {
  let server: Server;
  let directSql: DirectSql;
  let identitySql: IdentitySql;
  let platformSql: PlatformSql;
  const kms = createLocalKmsPort();
  const testMail = new TestMail();
  const loggedMessages: string[] = [];
  const now = new Date("2026-10-25T12:00:00.000Z");

  beforeAll(async () => {
    const runtime = loadRuntime();
    directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    identitySql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    platformSql = createPlaintextPlatformSql(roleUrl(runtime, "platform"));

    await applyProductMigrations(directSql);
    await directSql`delete from identity.operator_events`;
    await directSql`delete from identity.operator_grants`;
    await directSql`delete from identity.sessions`;
    await directSql`delete from identity.passkey_credentials`;
    await directSql`delete from identity.passkey_challenges`;
    await directSql`delete from identity.otp_challenges`;
    await directSql`delete from identity.users`;
    await directSql`delete from identity.identity_keys`;

    const checkout: Checkout<AnySql> = (role, run) => {
      if (role === "identity") {
        return run(identitySql);
      }
      if (role === "platform") {
        return run(platformSql);
      }
      throw new Error(`Unexpected role: ${role}`);
    };

    server = startServer({
      env: envFor(PORT),
      routes: opsRoutes({
        checkout,
        kms,
        keyArn: KEY_ARN,
        mail: testMail,
        now: () => now,
        opsHostname: OPS_HOSTNAME,
        log: (message: string) => {
          loggedMessages.push(message);
        },
      }),
    });

    await new Promise<void>((resolve, reject) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
  });

  afterAll(async () => {
    try {
      if (server) {
        await new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        });
      }
      await directSql`delete from identity.operator_events`;
      await directSql`delete from identity.operator_grants`;
      await directSql`delete from identity.sessions`;
      await directSql`delete from identity.passkey_credentials`;
      await directSql`delete from identity.passkey_challenges`;
      await directSql`delete from identity.otp_challenges`;
      await directSql`delete from identity.users`;
    } finally {
      await identitySql.end({ timeout: 1 });
      await platformSql.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("pin 2: every ops POST refuses a missing, null or foreign Origin", async () => {
    const postRoutes = [
      { path: "/v1/ops/enrolment/start", body: { email: "op-pin2@example.test" } },
      {
        path: "/v1/ops/enrolment/verify",
        body: {
          email: "op-pin2@example.test",
          emailCode: "12345678",
          enrolmentCode: ENROLMENT_CODE,
        },
      },
      { path: "/v1/ops/passkey/register/options", body: {} },
      {
        path: "/v1/ops/passkey/register/verify",
        body: { clientDataJSON: "abc", attestationObject: "def" },
      },
    ];

    const countsBefore = await getCounts(directSql);

    for (const r of postRoutes) {
      // 1. Missing Origin
      const resMissing = await opsFetch(PORT, r.path, {
        body: r.body,
        omitOrigin: true,
      });
      expect(resMissing.status).toBe(403);
      expect(await resMissing.text()).toBe("");

      // 2. Origin: null
      const resNull = await opsFetch(PORT, r.path, {
        body: r.body,
        origin: "null",
      });
      expect(resNull.status).toBe(403);
      expect(await resNull.text()).toBe("");

      // 3. Foreign Origin
      const resForeign = await opsFetch(PORT, r.path, {
        body: r.body,
        origin: "https://api.example.test",
      });
      expect(resForeign.status).toBe(403);
      expect(await resForeign.text()).toBe("");
    }

    const countsAfter = await getCounts(directSql);
    expect(countsAfter).toEqual(countsBefore);
  });

  it("pin 14: a malformed body is 400 only after a valid Origin", async () => {
    const postRoutes = [
      "/v1/ops/enrolment/start",
      "/v1/ops/enrolment/verify",
      "/v1/ops/passkey/register/options",
      "/v1/ops/passkey/register/verify",
    ];

    const countsBefore = await getCounts(directSql);

    for (const path of postRoutes) {
      // Bad JSON with foreign origin -> 403
      const resForeign = await opsFetch(PORT, path, {
        rawBody: "not json {",
        origin: "https://api.example.test",
      });
      expect(resForeign.status).toBe(403);
      expect(await resForeign.text()).toBe("");

      // Bad JSON with valid origin -> 400
      const resValidOrigin = await opsFetch(PORT, path, {
        rawBody: "not json {",
        origin: ORIGIN,
      });
      expect(resValidOrigin.status).toBe(400);
      expect(await resValidOrigin.text()).toBe("");
    }

    const countsAfter = await getCounts(directSql);
    expect(countsAfter).toEqual(countsBefore);
  });

  it("pin 6: enrolment start answers 204 alike with and without a grant", async () => {
    const userOpen = await findOrCreateUserByEmail(identitySql, kms, KEY_ARN, {
      email: "op-alike-open@example.test",
    });
    await grantOperator(identitySql, kms, KEY_ARN, {
      userId: userOpen.userId,
      roleKeys: ["platform_admin"],
      enrolmentCode: ENROLMENT_CODE,
      opsRpId: RP_ID,
      now,
    });

    // 1. With open grant
    const resOpen = await opsFetch(PORT, "/v1/ops/enrolment/start", {
      body: { email: "op-alike-open@example.test" },
    });
    expect(resOpen.status).toBe(204);
    const bodyOpen = await resOpen.text();
    expect(bodyOpen).toBe("");
    expect(resOpen.headers.get("cache-control")).toBe("no-store");
    expect(resOpen.headers.get("set-cookie")).toBeNull();

    await pollUntil(
      () => testMail.last?.to === "op-alike-open@example.test",
      "waiting for open grant email to send",
    );

    // 2. Without grant
    const resNone = await opsFetch(PORT, "/v1/ops/enrolment/start", {
      body: { email: "op-alike-none@example.test" },
    });
    expect(resNone.status).toBe(204);
    const bodyNone = await resNone.text();
    expect(bodyNone).toBe("");
    expect(resNone.headers.get("cache-control")).toBe("no-store");
    expect(resNone.headers.get("set-cookie")).toBeNull();

    // Check status, body, cache-control and set-cookie are identical
    expect(resNone.status).toBe(resOpen.status);
    expect(bodyNone).toBe(bodyOpen);
    expect(resNone.headers.get("cache-control")).toBe(resOpen.headers.get("cache-control"));
    expect(resNone.headers.get("set-cookie")).toBe(resOpen.headers.get("set-cookie"));

    // 3. Mail port that never resolves -> response still arrives within 5s
    const userHang = await findOrCreateUserByEmail(identitySql, kms, KEY_ARN, {
      email: "op-hang@example.test",
    });
    await grantOperator(identitySql, kms, KEY_ARN, {
      userId: userHang.userId,
      roleKeys: ["platform_admin"],
      enrolmentCode: ENROLMENT_CODE,
      opsRpId: RP_ID,
      now,
    });

    let resolveHang: () => void = () => {};
    const hangPromise = new Promise<void>((r) => {
      resolveHang = r;
    });
    testMail.activeHandler = () => hangPromise;

    try {
      const resHang = await opsFetch(PORT, "/v1/ops/enrolment/start", {
        body: { email: "op-hang@example.test" },
      });
      expect(resHang.status).toBe(204);
    } finally {
      resolveHang();
      testMail.activeHandler = undefined;
    }

    // 4. Mail port that rejects -> 204, process survives, unhandledRejection not called, logged failure
    const userReject = await findOrCreateUserByEmail(identitySql, kms, KEY_ARN, {
      email: "op-reject@example.test",
    });
    await grantOperator(identitySql, kms, KEY_ARN, {
      userId: userReject.userId,
      roleKeys: ["platform_admin"],
      enrolmentCode: ENROLMENT_CODE,
      opsRpId: RP_ID,
      now,
    });

    testMail.activeHandler = () => Promise.reject(new Error("mail failure"));
    const spy = vi.fn();
    process.on("unhandledRejection", spy);

    try {
      const resReject = await opsFetch(PORT, "/v1/ops/enrolment/start", {
        body: { email: "op-reject@example.test" },
      });
      expect(resReject.status).toBe(204);

      await pollUntil(() => {
        if (spy.mock.calls.length > 0) {
          throw new Error("unhandledRejection triggered: missing .catch handler");
        }
        return loggedMessages.includes("ops_enrolment_start_failed");
      }, "waiting for ops_enrolment_start_failed log");
      await new Promise((r) => setImmediate(r));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", spy);
      testMail.activeHandler = undefined;
    }
  });

  it("pin 5b: enrolment verify clears an operator refresh cookie", async () => {
    const userPin5b = await findOrCreateUserByEmail(identitySql, kms, KEY_ARN, {
      email: "op-pin5b@example.test",
    });
    await grantOperator(identitySql, kms, KEY_ARN, {
      userId: userPin5b.userId,
      roleKeys: ["platform_admin"],
      enrolmentCode: ENROLMENT_CODE,
      opsRpId: RP_ID,
      now,
    });

    const startRes = await opsFetch(PORT, "/v1/ops/enrolment/start", {
      body: { email: "op-pin5b@example.test" },
    });
    expect(startRes.status).toBe(204);

    await pollUntil(() => testMail.last?.to === "op-pin5b@example.test", "waiting for OTP mail");
    const emailCode = testMail.last!.code;

    const verifyRes = await opsFetch(PORT, "/v1/ops/enrolment/verify", {
      body: {
        email: "op-pin5b@example.test",
        emailCode,
        enrolmentCode: ENROLMENT_CODE,
      },
      cookie: "__Host-ops_rt=stale-refresh-token-xyz",
    });
    expect(verifyRes.status).toBe(200);
    const verifyData = (await verifyRes.json()) as { status: string };
    expect(verifyData.status).toBe("enrolment");

    const cookies = verifyRes.headers.getSetCookie();
    const accessCookie = cookies.find((c) => c.startsWith("__Host-ops_at="));
    const refreshCookie = cookies.find((c) => c.startsWith("__Host-ops_rt="));

    expect(accessCookie).toBeDefined();
    expect(accessCookie).not.toContain("Max-Age=0");
    expect(accessCookie).toContain("HttpOnly");
    expect(accessCookie).toContain("SameSite=Strict");

    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toContain("Max-Age=0");
    expect(refreshCookie).toContain("HttpOnly");
    expect(refreshCookie).toContain("SameSite=Strict");
  });

  it("enrolment and passkey registration flow", async () => {
    const email = "op-flow@example.test";
    const user = await findOrCreateUserByEmail(identitySql, kms, KEY_ARN, { email });
    await grantOperator(identitySql, kms, KEY_ARN, {
      userId: user.userId,
      roleKeys: ["platform_admin"],
      enrolmentCode: ENROLMENT_CODE,
      opsRpId: RP_ID,
      now,
    });

    // 1. Enrolment start
    const startRes = await opsFetch(PORT, "/v1/ops/enrolment/start", {
      body: { email },
    });
    expect(startRes.status).toBe(204);
    await pollUntil(() => testMail.last?.to === email, "waiting for OTP mail");
    const code = testMail.last!.code;

    // 2. Wrong codes -> 401 and both cleared
    const wrongRes = await opsFetch(PORT, "/v1/ops/enrolment/verify", {
      body: {
        email,
        emailCode: "00000000",
        enrolmentCode: ENROLMENT_CODE,
      },
    });
    expect(wrongRes.status).toBe(401);
    const wrongCookies = wrongRes.headers.getSetCookie();
    expect(wrongCookies.find((c) => c.startsWith("__Host-ops_at="))?.includes("Max-Age=0")).toBe(
      true,
    );
    expect(wrongCookies.find((c) => c.startsWith("__Host-ops_rt="))?.includes("Max-Age=0")).toBe(
      true,
    );

    // 3. Right codes -> 200 {"status":"enrolment"}, only access cookie set
    const verifyRes = await opsFetch(PORT, "/v1/ops/enrolment/verify", {
      body: {
        email,
        emailCode: code,
        enrolmentCode: ENROLMENT_CODE,
      },
    });
    expect(verifyRes.status).toBe(200);
    const verifyData = (await verifyRes.json()) as { status: string };
    expect(verifyData.status).toBe("enrolment");

    const setCookies = verifyRes.headers.getSetCookie();
    const atCookieHeader = setCookies.find((c) => c.startsWith("__Host-ops_at="));
    expect(atCookieHeader).toBeDefined();
    expect(atCookieHeader).not.toContain("Max-Age=0");
    const tokenMatch = /^__Host-ops_at=([^;]+)/.exec(atCookieHeader!);
    expect(tokenMatch).not.toBeNull();
    const accessToken = tokenMatch![1]!;

    // 4. register/options without cookie -> 401
    const unauthOpts = await opsFetch(PORT, "/v1/ops/passkey/register/options", {
      body: {},
    });
    expect(unauthOpts.status).toBe(401);

    // 5. register/options with enrolment cookie -> 200 options (UV required, RP ID ops.example.test)
    const optsRes1 = await opsFetch(PORT, "/v1/ops/passkey/register/options", {
      body: {},
      cookie: `__Host-ops_at=${accessToken}`,
    });
    expect(optsRes1.status).toBe(200);
    const options1 = (await optsRes1.json()) as {
      challenge: string;
      rp: { id: string; name: string };
      authenticatorSelection: { userVerification: string };
    };
    expect(options1.rp.id).toBe(RP_ID);
    expect(options1.authenticatorSelection.userVerification).toBe("required");
    const challenge1 = bytesFrom(options1.challenge);

    // 6. Refused ceremony (tampered client data) -> 400
    const tamperedClient = clientData("webauthn.tampered", challenge1);
    const key1 = await signer();
    const credId1 = new Uint8Array(16).fill(1);
    const authData1 = authenticatorData({
      signCount: 0,
      credentialId: credId1,
      cose: coseKey(key1.x, key1.y),
      flags: 0x45,
    });
    const refuseRes = await opsFetch(PORT, "/v1/ops/passkey/register/verify", {
      body: {
        clientDataJSON: b64(tamperedClient),
        attestationObject: b64(attestationObject(authData1)),
      },
      cookie: `__Host-ops_at=${accessToken}`,
    });
    expect(refuseRes.status).toBe(400);

    // 7. Register first passkey -> 200 {"activated":false}
    const validClient1 = clientData("webauthn.create", challenge1);
    const regRes1 = await opsFetch(PORT, "/v1/ops/passkey/register/verify", {
      body: {
        clientDataJSON: b64(validClient1),
        attestationObject: b64(attestationObject(authData1)),
      },
      cookie: `__Host-ops_at=${accessToken}`,
    });
    expect(regRes1.status).toBe(200);
    const regData1 = (await regRes1.json()) as { activated: boolean };
    expect(regData1.activated).toBe(false);
    expect(regRes1.headers.getSetCookie().some((c) => c.startsWith("__Host-ops_at="))).toBe(false);

    // 8. Register second passkey: get options
    const optsRes2 = await opsFetch(PORT, "/v1/ops/passkey/register/options", {
      body: {},
      cookie: `__Host-ops_at=${accessToken}`,
    });
    expect(optsRes2.status).toBe(200);
    const options2 = (await optsRes2.json()) as {
      challenge: string;
      rp: { id: string; name: string };
      authenticatorSelection: { userVerification: string };
    };
    const challenge2 = bytesFrom(options2.challenge);

    // 9. Register second passkey: verify -> 200 {"activated":true} with __Host-ops_at cleared
    const key2 = await signer();
    const credId2 = new Uint8Array(16).fill(2);
    const authData2 = authenticatorData({
      signCount: 0,
      credentialId: credId2,
      cose: coseKey(key2.x, key2.y),
      flags: 0x45,
    });
    const validClient2 = clientData("webauthn.create", challenge2);
    const regRes2 = await opsFetch(PORT, "/v1/ops/passkey/register/verify", {
      body: {
        clientDataJSON: b64(validClient2),
        attestationObject: b64(attestationObject(authData2)),
      },
      cookie: `__Host-ops_at=${accessToken}`,
    });
    expect(regRes2.status).toBe(200);
    const regData2 = (await regRes2.json()) as { activated: boolean };
    expect(regData2.activated).toBe(true);

    const clearedCookies = regRes2.headers.getSetCookie();
    const clearedAt = clearedCookies.find((c) => c.startsWith("__Host-ops_at="));
    expect(clearedAt).toBeDefined();
    expect(clearedAt).toContain("Max-Age=0");

    // 10. Further register/options with that old cookie -> 401
    const furtherOpts = await opsFetch(PORT, "/v1/ops/passkey/register/options", {
      body: {},
      cookie: `__Host-ops_at=${accessToken}`,
    });
    expect(furtherOpts.status).toBe(401);
  });

  it("operator session registers an additional passkey without being signed out", async () => {
    const email = "op-reg-operator-session@example.test";
    const user = await findOrCreateUserByEmail(identitySql, kms, KEY_ARN, { email });
    await grantOperator(identitySql, kms, KEY_ARN, {
      userId: user.userId,
      roleKeys: ["platform_admin"],
      enrolmentCode: ENROLMENT_CODE,
      opsRpId: RP_ID,
      now,
    });

    // 1. Enrolment start
    const startRes = await opsFetch(PORT, "/v1/ops/enrolment/start", {
      body: { email },
    });
    expect(startRes.status).toBe(204);
    await pollUntil(() => testMail.last?.to === email, "waiting for OTP mail");
    const code = testMail.last!.code;

    // 2. Enrolment verify
    const verifyRes = await opsFetch(PORT, "/v1/ops/enrolment/verify", {
      body: {
        email,
        emailCode: code,
        enrolmentCode: ENROLMENT_CODE,
      },
    });
    expect(verifyRes.status).toBe(200);
    const setCookies = verifyRes.headers.getSetCookie();
    const atCookieHeader = setCookies.find((c) => c.startsWith("__Host-ops_at="));
    const tokenMatch = /^__Host-ops_at=([^;]+)/.exec(atCookieHeader!);
    const enrolmentAccessToken = tokenMatch![1]!;

    // 3. Register passkey 1
    const optsRes1 = await opsFetch(PORT, "/v1/ops/passkey/register/options", {
      body: {},
      cookie: `__Host-ops_at=${enrolmentAccessToken}`,
    });
    expect(optsRes1.status).toBe(200);
    const options1 = (await optsRes1.json()) as { challenge: string };
    const challenge1 = bytesFrom(options1.challenge);

    const key1 = await signer();
    const credId1 = new Uint8Array(16).fill(11);
    const authData1 = authenticatorData({
      signCount: 0,
      credentialId: credId1,
      cose: coseKey(key1.x, key1.y),
      flags: 0x45,
    });
    const validClient1 = clientData("webauthn.create", challenge1);
    const regRes1 = await opsFetch(PORT, "/v1/ops/passkey/register/verify", {
      body: {
        clientDataJSON: b64(validClient1),
        attestationObject: b64(attestationObject(authData1)),
      },
      cookie: `__Host-ops_at=${enrolmentAccessToken}`,
    });
    expect(regRes1.status).toBe(200);
    expect(((await regRes1.json()) as { activated: boolean }).activated).toBe(false);

    // 4. Register passkey 2 -> activates operator
    const optsRes2 = await opsFetch(PORT, "/v1/ops/passkey/register/options", {
      body: {},
      cookie: `__Host-ops_at=${enrolmentAccessToken}`,
    });
    expect(optsRes2.status).toBe(200);
    const options2 = (await optsRes2.json()) as { challenge: string };
    const challenge2 = bytesFrom(options2.challenge);

    const key2 = await signer();
    const credId2 = new Uint8Array(16).fill(12);
    const authData2 = authenticatorData({
      signCount: 0,
      credentialId: credId2,
      cose: coseKey(key2.x, key2.y),
      flags: 0x45,
    });
    const validClient2 = clientData("webauthn.create", challenge2);
    const regRes2 = await opsFetch(PORT, "/v1/ops/passkey/register/verify", {
      body: {
        clientDataJSON: b64(validClient2),
        attestationObject: b64(attestationObject(authData2)),
      },
      cookie: `__Host-ops_at=${enrolmentAccessToken}`,
    });
    expect(regRes2.status).toBe(200);
    expect(((await regRes2.json()) as { activated: boolean }).activated).toBe(true);

    // 5. Sign the operator in through the identity public functions directly
    const auth = await beginOperatorAuthentication(identitySql, {
      opsRpId: RP_ID,
      now,
    });
    const authAuthData = authenticatorData({ signCount: 1, flags: 0x05 });
    const authClient = clientData("webauthn.get", auth.challenge);
    const sig = await key1.sign(concat([authAuthData, sha256(authClient)]));

    const tokens = await finishOperatorAuthentication(identitySql, kms, KEY_ARN, {
      opsRpId: RP_ID,
      now,
      credentialId: credId1,
      clientDataJSON: authClient,
      authenticatorData: authAuthData,
      signature: sig,
    });
    expect(tokens).not.toBeNull();
    const operatorAccessToken = tokens!.accessToken;

    // 6. register/options -> 200 with operator session
    const optsRes3 = await opsFetch(PORT, "/v1/ops/passkey/register/options", {
      body: {},
      cookie: `__Host-ops_at=${operatorAccessToken}`,
    });
    expect(optsRes3.status).toBe(200);
    const options3 = (await optsRes3.json()) as { challenge: string };
    const challenge3 = bytesFrom(options3.challenge);

    // 7. register/verify for a third passkey -> 200 {"activated": false} with no set-cookie clearing __Host-ops_at
    const key3 = await signer();
    const credId3 = new Uint8Array(16).fill(13);
    const authData3 = authenticatorData({
      signCount: 0,
      credentialId: credId3,
      cose: coseKey(key3.x, key3.y),
      flags: 0x45,
    });
    const validClient3 = clientData("webauthn.create", challenge3);
    const regRes3 = await opsFetch(PORT, "/v1/ops/passkey/register/verify", {
      body: {
        clientDataJSON: b64(validClient3),
        attestationObject: b64(attestationObject(authData3)),
      },
      cookie: `__Host-ops_at=${operatorAccessToken}`,
    });
    expect(regRes3.status).toBe(200);
    const regData3 = (await regRes3.json()) as { activated: boolean };
    expect(regData3.activated).toBe(false);

    const regCookies = regRes3.headers.getSetCookie();
    expect(regCookies.some((c) => c.startsWith("__Host-ops_at="))).toBe(false);
  });
});
