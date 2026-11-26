import { createHmac } from "node:crypto";
import type { KmsPort } from "@community-hub/crypto";
import {
  confirmTotpSetup,
  readSecondFactorPrompt,
  rejectingSecondFactorNotice,
  startEmailOtp,
  startTotpSetup,
  verifyEmailOtp,
  verifySecondStep,
  type OtpMail,
  type SessionTokens,
} from "@community-hub/identity";

type IdentitySql = Parameters<typeof startEmailOtp>[0];

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const enrolledSecretsByOriginEmail = new Map<string, string>();
const enrolledSecretsByUserId = new Map<string, string>();

function base32Decode(value: string): Uint8Array {
  const clean = value.replace(/=+$/u, "").toUpperCase();
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) {
      throw new Error("invalid base32 TOTP secret");
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

export function generateTotpCode(secretBase32: string, now: Date): string {
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

class CapturingMail implements OtpMail {
  lastCode = "";
  send(input: { to: string; code: string }): Promise<void> {
    this.lastCode = input.code;
    return Promise.resolve();
  }
}

export async function signInWithTotp(
  httpFetch: typeof globalThis.fetch,
  email: string,
  options: {
    origin: string;
    hostname?: string;
    readEmailCode: () => string;
    now?: () => Date;
  },
): Promise<SessionTokens> {
  const hostname = options.hostname ?? "auth.au.example.test";
  const now = options.now ?? (() => new Date());
  const post = async (path: string, body: unknown, accessToken?: string): Promise<Response> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-community-hub-hostname": hostname,
    };
    if (accessToken !== undefined) {
      headers.authorization = `Bearer ${accessToken}`;
    }
    return httpFetch(`${options.origin}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  };

  const started = await post("/v1/auth/email-otp/start", { email });
  if (started.status !== 204) {
    throw new Error(`email-otp/start failed with ${started.status}`);
  }
  const emailCode = options.readEmailCode();
  const verifiedRes = await post("/v1/auth/email-otp/verify", { email, code: emailCode });
  if (verifiedRes.status !== 200) {
    throw new Error(`email-otp/verify failed with ${verifiedRes.status}`);
  }
  const verified = (await verifiedRes.json()) as {
    secondFactor: "verify" | "setup";
    accessToken: string;
  };
  const cacheKey = `${options.origin}\0${email.toLowerCase()}`;

  if (verified.secondFactor === "setup") {
    const startRes = await post("/v1/auth/second-factor/totp/start", {}, verified.accessToken);
    if (startRes.status !== 200) {
      throw new Error(`totp/start failed with ${startRes.status}`);
    }
    const startBody = (await startRes.json()) as { secret: string };
    enrolledSecretsByOriginEmail.set(cacheKey, startBody.secret);
    const confirmRes = await post(
      "/v1/auth/second-factor/totp/confirm",
      { code: generateTotpCode(startBody.secret, now()) },
      verified.accessToken,
    );
    if (confirmRes.status !== 200) {
      throw new Error(`totp/confirm failed with ${confirmRes.status}`);
    }
    const confirmed = (await confirmRes.json()) as SessionTokens;
    return {
      userId: confirmed.userId,
      accessToken: confirmed.accessToken,
      refreshToken: confirmed.refreshToken,
      expiresIn: confirmed.expiresIn,
    };
  }

  const secret = enrolledSecretsByOriginEmail.get(cacheKey);
  if (secret === undefined) {
    throw new Error(`missing enrolled TOTP secret for ${email}`);
  }
  const stepRes = await post(
    "/v1/auth/second-factor/verify",
    { method: "totp", code: generateTotpCode(secret, now()) },
    verified.accessToken,
  );
  if (stepRes.status !== 200) {
    throw new Error(`second-factor/verify failed with ${stepRes.status}`);
  }
  const stepBody = (await stepRes.json()) as SessionTokens;
  return {
    userId: stepBody.userId,
    accessToken: stepBody.accessToken,
    refreshToken: stepBody.refreshToken,
    expiresIn: stepBody.expiresIn,
  };
}

export async function signInWithTotpInProcess(
  sql: IdentitySql,
  kms: KmsPort,
  keyArn: string,
  email: string,
  now: Date,
): Promise<SessionTokens> {
  const mail = new CapturingMail();
  await startEmailOtp(sql, kms, keyArn, mail, { email, now });
  const pre = await verifyEmailOtp(sql, kms, keyArn, {
    email,
    code: mail.lastCode,
    now,
  });
  if (pre === null) {
    throw new Error("verifyEmailOtp failed in signInWithTotpInProcess");
  }
  const prompt = await readSecondFactorPrompt(sql, { userId: pre.userId, adminRpId: null });
  if (prompt.secondFactor === "setup") {
    const started = await startTotpSetup(sql, kms, keyArn, {
      accessToken: pre.accessToken,
      now,
      adminRpId: null,
    });
    if (started.outcome !== "started") {
      throw new Error(`startTotpSetup failed: ${started.outcome}`);
    }
    enrolledSecretsByUserId.set(pre.userId, started.secret);
    const confirmed = await confirmTotpSetup(
      sql,
      kms,
      keyArn,
      {
        accessToken: pre.accessToken,
        now,
        code: generateTotpCode(started.secret, now),
        adminRpId: null,
      },
      { notice: rejectingSecondFactorNotice },
    );
    if (confirmed.outcome !== "confirmed" || confirmed.tokens === undefined) {
      throw new Error(`confirmTotpSetup failed: ${confirmed.outcome}`);
    }
    return confirmed.tokens;
  }

  const secret = enrolledSecretsByUserId.get(pre.userId);
  if (secret === undefined) {
    throw new Error(`missing enrolled TOTP secret for user ${pre.userId}`);
  }
  const step = await verifySecondStep(sql, kms, keyArn, {
    accessToken: pre.accessToken,
    now,
    method: "totp",
    code: generateTotpCode(secret, now),
  });
  if (step.outcome !== "verified") {
    throw new Error(`verifySecondStep failed: ${step.outcome}`);
  }
  return step.tokens;
}
