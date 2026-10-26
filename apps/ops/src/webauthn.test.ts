import { describe, expect, it } from "vitest";
import type {
  PasskeyAuthenticateOptionsResponse,
  PasskeyRegisterOptionsResponse,
} from "@community-hub/contracts/ops";

import {
  assertionBody,
  ceremonyMessage,
  isAuthenticateOptions,
  isRegisterOptions,
  registrationBody,
  toCreationOptions,
  toRequestOptions,
} from "./webauthn.js";
import {
  CEREMONY_CANCELLED_MESSAGE,
  CEREMONY_DEFAULT_MESSAGE,
  CEREMONY_SAME_DEVICE_MESSAGE,
} from "./messages.js";

describe("webauthn", () => {
  const sampleRegisterResponse: PasskeyRegisterOptionsResponse = {
    challenge: "AQID", // [1, 2, 3]
    rp: {
      id: "ops.example.test",
      name: "Community Hub operations",
    },
    user: {
      id: "BAUG", // [4, 5, 6]
      name: "Community Hub operator",
      displayName: "Community Hub operator",
    },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    attestation: "none",
    authenticatorSelection: {
      userVerification: "required",
      residentKey: "required",
    },
    excludeCredentials: [
      {
        type: "public-key",
        id: "BwgJ", // [7, 8, 9]
      },
    ],
  };

  const sampleAuthenticateResponse: PasskeyAuthenticateOptionsResponse = {
    challenge: "AQID",
    rpId: "ops.example.test",
    userVerification: "required",
  };

  describe("conversions", () => {
    it("toCreationOptions turns response into byte arrays and keeps rp.name and labels", () => {
      const options = toCreationOptions(sampleRegisterResponse);

      expect(options.challenge).toEqual(new Uint8Array([1, 2, 3]));
      expect(options.rp).toEqual({
        id: "ops.example.test",
        name: "Community Hub operations",
      });
      expect(options.user).toEqual({
        id: new Uint8Array([4, 5, 6]),
        name: "Community Hub operator",
        displayName: "Community Hub operator",
      });
      expect(options.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
      expect(options.attestation).toBe("none");
      expect(options.authenticatorSelection).toEqual({
        userVerification: "required",
        residentKey: "required",
      });
      expect(options.excludeCredentials).toEqual([
        {
          type: "public-key",
          id: new Uint8Array([7, 8, 9]),
        },
      ]);
    });

    it("toCreationOptions preserves empty excludeCredentials array", () => {
      const withEmptyExclude: PasskeyRegisterOptionsResponse = {
        ...sampleRegisterResponse,
        excludeCredentials: [],
      };
      const options = toCreationOptions(withEmptyExclude);
      expect(options.excludeCredentials).toEqual([]);
    });

    it("toRequestOptions has no allowCredentials", () => {
      const options = toRequestOptions(sampleAuthenticateResponse);

      expect(options.challenge).toEqual(new Uint8Array([1, 2, 3]));
      expect(options.rpId).toBe("ops.example.test");
      expect(options.userVerification).toBe("required");
      expect("allowCredentials" in options).toBe(false);
    });

    it("registrationBody encodes clientDataJSON and attestationObject", () => {
      const cred = {
        response: {
          clientDataJSON: new Uint8Array([1, 2, 3]).buffer,
          attestationObject: new Uint8Array([4, 5, 6]).buffer,
        },
      } as unknown as PublicKeyCredential;

      const body = registrationBody(cred);
      expect(body).toEqual({
        clientDataJSON: "AQID",
        attestationObject: "BAUG",
      });
    });

    it("assertionBody never has userHandle, even when the credential has one", () => {
      const cred = {
        rawId: new Uint8Array([1, 2, 3]).buffer,
        response: {
          clientDataJSON: new Uint8Array([4, 5, 6]).buffer,
          authenticatorData: new Uint8Array([7, 8, 9]).buffer,
          signature: new Uint8Array([10, 11, 12]).buffer,
          userHandle: new Uint8Array([99]).buffer,
        },
      } as unknown as PublicKeyCredential;

      const body = assertionBody(cred);
      expect(body).toEqual({
        credentialId: "AQID",
        clientDataJSON: "BAUG",
        authenticatorData: "BwgJ",
        signature: "CgsM",
      });
      expect("userHandle" in body).toBe(false);
    });
  });

  describe("guards", () => {
    it("isRegisterOptions accepts valid options and rejects missing rp.name or excludeCredentials", () => {
      expect(isRegisterOptions(sampleRegisterResponse)).toBe(true);

      const missingRpName = {
        ...sampleRegisterResponse,
        rp: { id: "ops.example.test" },
      };
      expect(isRegisterOptions(missingRpName)).toBe(false);

      const missingExclude = {
        ...sampleRegisterResponse,
      } as Partial<PasskeyRegisterOptionsResponse>;
      delete missingExclude.excludeCredentials;
      expect(isRegisterOptions(missingExclude)).toBe(false);

      expect(isRegisterOptions(null)).toBe(false);
      expect(isRegisterOptions({})).toBe(false);
      expect(isRegisterOptions("string")).toBe(false);
    });

    it("isAuthenticateOptions accepts valid options and rejects invalid shapes", () => {
      expect(isAuthenticateOptions(sampleAuthenticateResponse)).toBe(true);
      expect(isAuthenticateOptions({ challenge: "AQID", rpId: "ops.example.test" })).toBe(true);

      expect(isAuthenticateOptions({ challenge: "AQID" })).toBe(false);
      expect(isAuthenticateOptions({ rpId: "ops.example.test" })).toBe(false);
      expect(isAuthenticateOptions(null)).toBe(false);
      expect(isAuthenticateOptions({})).toBe(false);
    });
  });

  describe("ceremonyMessage (Pin 8)", () => {
    it("maps each error class to fixed text", () => {
      // NotAllowedError and AbortError -> cancelled text
      expect(
        ceremonyMessage(new DOMException("user cancelled", "NotAllowedError"), "register"),
      ).toBe(CEREMONY_CANCELLED_MESSAGE);
      expect(ceremonyMessage({ name: "NotAllowedError" }, "register")).toBe(
        CEREMONY_CANCELLED_MESSAGE,
      );
      expect(ceremonyMessage(new DOMException("aborted", "AbortError"), "authenticate")).toBe(
        CEREMONY_CANCELLED_MESSAGE,
      );
      expect(ceremonyMessage({ name: "AbortError" }, "authenticate")).toBe(
        CEREMONY_CANCELLED_MESSAGE,
      );

      // InvalidStateError on register -> same-device text
      expect(
        ceremonyMessage(new DOMException("already exists", "InvalidStateError"), "register"),
      ).toBe(CEREMONY_SAME_DEVICE_MESSAGE);
      expect(ceremonyMessage({ name: "InvalidStateError" }, "register")).toBe(
        CEREMONY_SAME_DEVICE_MESSAGE,
      );

      // InvalidStateError on authenticate -> default text
      expect(ceremonyMessage(new DOMException("state", "InvalidStateError"), "authenticate")).toBe(
        CEREMONY_DEFAULT_MESSAGE,
      );
      expect(ceremonyMessage({ name: "InvalidStateError" }, "authenticate")).toBe(
        CEREMONY_DEFAULT_MESSAGE,
      );

      // Other errors, TypeError, {}, undefined, null, primitives -> default text
      expect(ceremonyMessage(new TypeError("type error"), "register")).toBe(
        CEREMONY_DEFAULT_MESSAGE,
      );
      expect(ceremonyMessage({}, "register")).toBe(CEREMONY_DEFAULT_MESSAGE);
      expect(ceremonyMessage(undefined, "register")).toBe(CEREMONY_DEFAULT_MESSAGE);
      expect(ceremonyMessage(null, "authenticate")).toBe(CEREMONY_DEFAULT_MESSAGE);
      expect(ceremonyMessage("unknown error", "authenticate")).toBe(CEREMONY_DEFAULT_MESSAGE);
      expect(ceremonyMessage(42, "register")).toBe(CEREMONY_DEFAULT_MESSAGE);
    });

    it("never shows browser error text from a DOMException with secret detail", () => {
      const secretError = new DOMException("secret detail", "UnknownError");
      const result = ceremonyMessage(secretError, "register");
      expect(result).not.toContain("secret detail");
      expect(result).toBe(CEREMONY_DEFAULT_MESSAGE);
    });
  });
});
