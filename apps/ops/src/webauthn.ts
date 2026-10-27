import type {
  PasskeyAuthenticateOptionsResponse,
  PasskeyRegisterOptionsResponse,
} from "@community-hub/contracts/ops";

import { decode, encode } from "./base64url.js";
import {
  CEREMONY_CANCELLED_MESSAGE,
  CEREMONY_DEFAULT_MESSAGE,
  CEREMONY_SAME_DEVICE_MESSAGE,
} from "./messages.js";

export function isRegisterOptions(value: unknown): value is PasskeyRegisterOptionsResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.challenge !== "string" || obj.challenge.length === 0) {
    return false;
  }
  if (
    typeof obj.rp !== "object" ||
    obj.rp === null ||
    typeof (obj.rp as Record<string, unknown>).id !== "string" ||
    typeof (obj.rp as Record<string, unknown>).name !== "string"
  ) {
    return false;
  }
  if (
    typeof obj.user !== "object" ||
    obj.user === null ||
    typeof (obj.user as Record<string, unknown>).id !== "string" ||
    typeof (obj.user as Record<string, unknown>).name !== "string" ||
    typeof (obj.user as Record<string, unknown>).displayName !== "string"
  ) {
    return false;
  }
  if (
    !Array.isArray(obj.pubKeyCredParams) ||
    obj.pubKeyCredParams.length === 0 ||
    !obj.pubKeyCredParams.every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        (p as Record<string, unknown>).type === "public-key" &&
        typeof (p as Record<string, unknown>).alg === "number",
    )
  ) {
    return false;
  }
  if (obj.attestation !== "none") {
    return false;
  }
  if (typeof obj.authenticatorSelection !== "object" || obj.authenticatorSelection === null) {
    return false;
  }
  const authSel = obj.authenticatorSelection as Record<string, unknown>;
  if (
    (authSel.userVerification !== "preferred" && authSel.userVerification !== "required") ||
    authSel.residentKey !== "required"
  ) {
    return false;
  }
  if (!Array.isArray(obj.excludeCredentials)) {
    return false;
  }
  for (const cred of obj.excludeCredentials) {
    if (
      typeof cred !== "object" ||
      cred === null ||
      (cred as Record<string, unknown>).type !== "public-key" ||
      typeof (cred as Record<string, unknown>).id !== "string"
    ) {
      return false;
    }
  }
  return true;
}

export function isAuthenticateOptions(value: unknown): value is PasskeyAuthenticateOptionsResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.challenge !== "string" || obj.challenge.length === 0) {
    return false;
  }
  if (typeof obj.rpId !== "string" || obj.rpId.length === 0) {
    return false;
  }
  if (obj.userVerification !== undefined && obj.userVerification !== "required") {
    return false;
  }
  return true;
}

export function toCreationOptions(
  json: PasskeyRegisterOptionsResponse,
): PublicKeyCredentialCreationOptions {
  return {
    challenge: decode(json.challenge),
    rp: json.rp,
    user: {
      id: decode(json.user.id),
      name: json.user.name,
      displayName: json.user.displayName,
    },
    pubKeyCredParams: json.pubKeyCredParams,
    attestation: json.attestation,
    authenticatorSelection: json.authenticatorSelection,
    excludeCredentials: json.excludeCredentials.map((c) => ({
      type: c.type,
      id: decode(c.id),
    })),
  };
}

export function toRequestOptions(
  json: PasskeyAuthenticateOptionsResponse,
): PublicKeyCredentialRequestOptions {
  const options: PublicKeyCredentialRequestOptions = {
    challenge: decode(json.challenge),
    rpId: json.rpId,
  };
  if (json.userVerification !== undefined) {
    options.userVerification = json.userVerification;
  }
  return options;
}

export function registrationBody(
  credential:
    | PublicKeyCredential
    | {
        response:
          | AuthenticatorAttestationResponse
          | { clientDataJSON: ArrayBuffer; attestationObject: ArrayBuffer };
      },
): {
  clientDataJSON: string;
  attestationObject: string;
} {
  const res = (credential as { response: AuthenticatorAttestationResponse }).response;
  return {
    clientDataJSON: encode(res.clientDataJSON),
    attestationObject: encode(res.attestationObject),
  };
}

export function assertionBody(
  credential:
    | PublicKeyCredential
    | {
        rawId: ArrayBuffer;
        response:
          | AuthenticatorAssertionResponse
          | { clientDataJSON: ArrayBuffer; authenticatorData: ArrayBuffer; signature: ArrayBuffer };
      },
): {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
} {
  const c = credential as { rawId: ArrayBuffer; response: AuthenticatorAssertionResponse };
  return {
    credentialId: encode(c.rawId),
    clientDataJSON: encode(c.response.clientDataJSON),
    authenticatorData: encode(c.response.authenticatorData),
    signature: encode(c.response.signature),
  };
}

export function ceremonyMessage(error: unknown, ceremony: "register" | "authenticate"): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = String((error as { name: unknown }).name);
    if (name === "NotAllowedError" || name === "AbortError") {
      return CEREMONY_CANCELLED_MESSAGE;
    }
    if (ceremony === "register" && name === "InvalidStateError") {
      return CEREMONY_SAME_DEVICE_MESSAGE;
    }
  }
  return CEREMONY_DEFAULT_MESSAGE;
}
