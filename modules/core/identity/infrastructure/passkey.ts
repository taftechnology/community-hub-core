import { newId } from "@community-hub/db";
import type { Sql } from "postgres";

import { decodeCbor, decodeCoseEc2 } from "../domain/cbor.js";
import { IdentityError } from "../domain/error.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const UP = 0x01;
const AT = 0x40;

export type PasskeyRegistrationOptions = {
  challenge: Uint8Array;
  rp: { id: string };
  user: { id: Uint8Array; name: string; displayName: string };
  pubKeyCredParams: [{ type: "public-key"; alg: -7 }];
  attestation: "none";
  authenticatorSelection: { userVerification: "preferred"; residentKey: "discouraged" };
};

export type PasskeyAuthenticationOptions = {
  challenge: Uint8Array;
  rpId: string;
};

export async function beginPasskeyRegistration(
  sql: Sql,
  input: { userId: string; rpId: string; now: Date },
): Promise<PasskeyRegistrationOptions> {
  const users = await sql<{ id: string }[]>`
    select id from identity.users where id = ${input.userId}
  `;
  if (users[0] === undefined) {
    throw new IdentityError("invalid_ceremony");
  }
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  const expiresAt = new Date(input.now.getTime() + FIVE_MINUTES_MS).toISOString();
  await sql`
    insert into identity.passkey_challenges (id, user_id, kind, challenge, expires_at)
    values (${newId()}, ${input.userId}, 'register', ${challenge}, ${expiresAt}::timestamptz)
  `;
  return {
    challenge,
    rp: { id: input.rpId },
    user: {
      id: uuidToBytes(input.userId),
      name: input.userId,
      displayName: input.userId,
    },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    attestation: "none",
    authenticatorSelection: { userVerification: "preferred", residentKey: "discouraged" },
  };
}

export async function finishPasskeyRegistration(
  sql: Sql,
  input: {
    userId: string;
    rpId: string;
    now: Date;
    clientDataJSON: Uint8Array;
    attestationObject: Uint8Array;
  },
): Promise<void> {
  const client = readClientData(input.clientDataJSON);
  if (client.type !== "webauthn.create" || !originMatches(client.origin, input.rpId)) {
    throw new IdentityError("invalid_ceremony");
  }
  const challenge = decodeBase64Url(client.challenge);
  const now = input.now.toISOString();
  const rows = await sql<{ id: string }[]>`
    select id from identity.passkey_challenges
    where user_id = ${input.userId}
      and kind = 'register'
      and challenge = ${challenge}
      and consumed_at is null
      and expires_at >= ${now}::timestamptz
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new IdentityError("invalid_ceremony");
  }
  const attested = readAttestation(input.attestationObject);
  const auth = parseAuthenticatorData(attested);
  if ((auth.flags & UP) === 0 || (auth.flags & AT) === 0) {
    throw new IdentityError("invalid_ceremony");
  }
  if (!sameBytes(auth.rpIdHash, await sha256(new TextEncoder().encode(input.rpId)))) {
    throw new IdentityError("invalid_ceremony");
  }
  if (auth.credentialId === null || auth.coseKey === null) {
    throw new IdentityError("invalid_ceremony");
  }
  decodeCoseEc2(auth.coseKey);
  try {
    await sql.begin(async (tx) => {
      await tx`
        update identity.passkey_challenges
        set consumed_at = ${now}::timestamptz
        where id = ${row.id}
      `;
      await tx`
        insert into identity.passkey_credentials (id, user_id, credential_id, cose_key, sign_count)
        values (
          ${newId()},
          ${input.userId},
          ${auth.credentialId},
          ${auth.coseKey},
          ${auth.signCount}
        )
      `;
    });
  } catch (error) {
    if (isCredentialConflict(error)) {
      throw new IdentityError("invalid_ceremony");
    }
    throw error;
  }
}

export async function beginPasskeyAuthentication(
  sql: Sql,
  input: { rpId: string; now: Date },
): Promise<PasskeyAuthenticationOptions> {
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  const expiresAt = new Date(input.now.getTime() + FIVE_MINUTES_MS).toISOString();
  await sql`
    insert into identity.passkey_challenges (id, user_id, kind, challenge, expires_at)
    values (${newId()}, null, 'authenticate', ${challenge}, ${expiresAt}::timestamptz)
  `;
  return { challenge, rpId: input.rpId };
}

export async function finishPasskeyAuthentication(
  sql: Sql,
  input: {
    rpId: string;
    now: Date;
    credentialId: Uint8Array;
    clientDataJSON: Uint8Array;
    authenticatorData: Uint8Array;
    signature: Uint8Array;
  },
): Promise<{ userId: string } | null> {
  try {
    const credentials = await sql<
      { id: string; user_id: string; cose_key: Uint8Array; sign_count: number | string }[]
    >`
      select id, user_id, cose_key, sign_count
      from identity.passkey_credentials
      where credential_id = ${input.credentialId}
    `;
    const credential = credentials[0];
    if (credential === undefined) {
      return null;
    }
    const client = readClientData(input.clientDataJSON);
    if (client.type !== "webauthn.get" || !originMatches(client.origin, input.rpId)) {
      return null;
    }
    const challenge = decodeBase64Url(client.challenge);
    const now = input.now.toISOString();
    const rows = await sql<{ id: string }[]>`
      select id from identity.passkey_challenges
      where user_id is null
        and kind = 'authenticate'
        and challenge = ${challenge}
        and consumed_at is null
        and expires_at >= ${now}::timestamptz
    `;
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const auth = parseAuthenticatorData(input.authenticatorData);
    if ((auth.flags & UP) === 0 || (auth.flags & AT) !== 0) {
      return null;
    }
    if (!sameBytes(auth.rpIdHash, await sha256(new TextEncoder().encode(input.rpId)))) {
      return null;
    }
    const clientHash = await sha256(input.clientDataJSON);
    const signed = concat([input.authenticatorData, clientHash]);
    const verified = await verifyEs256(credential.cose_key, signed, input.signature);
    if (!verified) {
      return null;
    }
    const stored = Number(credential.sign_count);
    if (!signCountAccepted(stored, auth.signCount)) {
      return null;
    }
    await sql.begin(async (tx) => {
      await tx`
        update identity.passkey_challenges
        set consumed_at = ${now}::timestamptz
        where id = ${row.id}
      `;
      await tx`
        update identity.passkey_credentials
        set sign_count = ${auth.signCount}
        where id = ${credential.id}
      `;
    });
    return { userId: credential.user_id };
  } catch (error) {
    if (error instanceof IdentityError && error.code === "invalid_ceremony") {
      return null;
    }
    throw error;
  }
}

function originMatches(origin: string, rpId: string): boolean {
  return origin === `https://${rpId}`;
}

function signCountAccepted(stored: number, next: number): boolean {
  if (stored === 0) {
    return next >= 0;
  }
  return next > stored;
}

function readClientData(bytes: Uint8Array): { type: string; challenge: string; origin: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new IdentityError("invalid_ceremony");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new IdentityError("invalid_ceremony");
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.type !== "string" ||
    typeof record.challenge !== "string" ||
    typeof record.origin !== "string"
  ) {
    throw new IdentityError("invalid_ceremony");
  }
  return { type: record.type, challenge: record.challenge, origin: record.origin };
}

function readAttestation(bytes: Uint8Array): Uint8Array {
  const value = decodeCbor(bytes);
  if (!(value instanceof Map)) {
    throw new IdentityError("invalid_ceremony");
  }
  const fmt = value.get("fmt");
  const attStmt = value.get("attStmt");
  const authData = value.get("authData");
  if (fmt !== "none" || !(attStmt instanceof Map) || attStmt.size !== 0) {
    throw new IdentityError("invalid_ceremony");
  }
  if (!(authData instanceof Uint8Array)) {
    throw new IdentityError("invalid_ceremony");
  }
  return authData;
}

function parseAuthenticatorData(bytes: Uint8Array): {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credentialId: Uint8Array | null;
  coseKey: Uint8Array | null;
} {
  if (bytes.byteLength < 37) {
    throw new IdentityError("invalid_ceremony");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rpIdHash = bytes.slice(0, 32);
  const flags = bytes[32] ?? 0;
  const signCount = view.getUint32(33);
  if ((flags & AT) === 0) {
    if (bytes.byteLength !== 37) {
      throw new IdentityError("invalid_ceremony");
    }
    return { rpIdHash, flags, signCount, credentialId: null, coseKey: null };
  }
  if (bytes.byteLength < 55) {
    throw new IdentityError("invalid_ceremony");
  }
  const credentialLength = view.getUint16(53);
  const credentialStart = 55;
  const credentialEnd = credentialStart + credentialLength;
  if (credentialEnd > bytes.byteLength) {
    throw new IdentityError("invalid_ceremony");
  }
  return {
    rpIdHash,
    flags,
    signCount,
    credentialId: bytes.slice(credentialStart, credentialEnd),
    coseKey: bytes.slice(credentialEnd),
  };
}

async function verifyEs256(
  coseKey: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (signature.byteLength !== 64) {
    return false;
  }
  const { x, y } = decodeCoseEc2(coseKey);
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: Buffer.from(x).toString("base64url"),
      y: Buffer.from(y).toString("base64url"),
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      copyBytes(signature),
      copyBytes(data),
    );
  } catch {
    return false;
  }
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copyBytes(bytes)));
}

function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(value.byteLength);
  out.set(value);
  return out;
}

function decodeBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
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

function isCredentialConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      current.constraint_name === "passkey_credentials_credential_id_unique"
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
