import { createHash, randomBytes } from "node:crypto";

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function isNilUuid(bytes: Uint8Array): boolean {
  for (let i = 0; i < 16; i++) {
    if (bytes[i] !== 0) {
      return false;
    }
  }
  return true;
}

const TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]{107}$/;

export function buildInvitationToken(input: {
  orgId: string;
  communityId: string;
  invitationId: string;
}): { token: string; tokenHash: Uint8Array } {
  const orgBytes = uuidToBytes(input.orgId);
  const commBytes = uuidToBytes(input.communityId);
  const invBytes = uuidToBytes(input.invitationId);
  const secret = randomBytes(32);

  const payload = Buffer.concat([orgBytes, commBytes, invBytes, secret]);
  const token = "v1." + payload.toString("base64url");
  const tokenHash = new Uint8Array(createHash("sha256").update(secret).digest());

  return { token, tokenHash };
}

export function parseInvitationToken(text: string):
  | {
      orgId: string;
      communityId: string;
      invitationId: string;
      secret: Uint8Array;
    }
  | "invalid" {
  if (typeof text !== "string" || !TOKEN_PATTERN.test(text)) {
    return "invalid";
  }

  const encodedPayload = text.slice(3);
  const buf = Buffer.from(encodedPayload, "base64url");
  if (buf.length !== 80) {
    return "invalid";
  }

  if (buf.toString("base64url") !== encodedPayload) {
    return "invalid";
  }

  const orgBytes = buf.subarray(0, 16);
  const commBytes = buf.subarray(16, 32);
  const invBytes = buf.subarray(32, 48);
  const secret = new Uint8Array(buf.subarray(48, 80));

  if (isNilUuid(orgBytes) || isNilUuid(commBytes) || isNilUuid(invBytes)) {
    return "invalid";
  }

  return {
    orgId: bytesToUuid(orgBytes),
    communityId: bytesToUuid(commBytes),
    invitationId: bytesToUuid(invBytes),
    secret,
  };
}
