import { describe, expect, it } from "vitest";

import {
  activatedResponse,
  directoryResponse,
  enrolmentStartBody,
  enrolmentStatusResponse,
  enrolmentVerifyBody,
  expiresInResponse,
  opsActivatedResponse,
  opsDirectoryResponse,
  opsEnrolmentStartBody,
  opsEnrolmentStatusResponse,
  opsEnrolmentVerifyBody,
  opsExpiresInResponse,
  opsMeResponse,
  opsPasskeyAuthenticateOptionsBody,
  opsPasskeyAuthenticateOptionsResponse,
  opsPasskeyAuthenticateVerifyBody,
  opsPasskeyRegisterOptionsBody,
  opsPasskeyRegisterOptionsResponse,
  opsPasskeyRegisterVerifyBody,
  opsRolesResponse,
  opsSessionEndBody,
  opsSessionRefreshBody,
  passkeyAuthenticateOptionsBody,
  passkeyAuthenticateOptionsResponse,
  passkeyAuthenticateVerifyBody,
  passkeyRegisterOptionsBody,
  passkeyRegisterOptionsResponse,
  passkeyRegisterVerifyBody,
  rolesResponse,
  sessionEndBody,
  sessionRefreshBody,
} from "./ops.js";

describe("ops request schemas", () => {
  it("enrolment start accepts a valid body and rejects extra, missing, and wrong type", () => {
    expect(enrolmentStartBody.safeParse({ email: "ada@example.test" }).success).toBe(true);
    expect(opsEnrolmentStartBody.safeParse({ email: "ada@example.test" }).success).toBe(true);

    expect(enrolmentStartBody.safeParse({ email: "ada@example.test", extra: 1 }).success).toBe(
      false,
    );
    expect(enrolmentStartBody.safeParse({}).success).toBe(false);
    expect(enrolmentStartBody.safeParse({ email: 123 }).success).toBe(false);
    expect(enrolmentStartBody.safeParse({ email: "" }).success).toBe(false);
  });

  it("enrolment verify accepts a valid body and rejects extra, missing, and wrong type", () => {
    const valid = {
      email: "ada@example.test",
      emailCode: "01234567",
      enrolmentCode: "code-abc-123",
    };
    expect(enrolmentVerifyBody.safeParse(valid).success).toBe(true);
    expect(opsEnrolmentVerifyBody.safeParse(valid).success).toBe(true);

    expect(enrolmentVerifyBody.safeParse({ ...valid, extra: "extra" }).success).toBe(false);
    expect(
      enrolmentVerifyBody.safeParse({ email: "ada@example.test", emailCode: "01234567" }).success,
    ).toBe(false);
    expect(
      enrolmentVerifyBody.safeParse({
        email: "ada@example.test",
        emailCode: 12345678,
        enrolmentCode: "code-abc-123",
      }).success,
    ).toBe(false);
    expect(
      enrolmentVerifyBody.safeParse({
        email: "",
        emailCode: "01234567",
        enrolmentCode: "code-abc-123",
      }).success,
    ).toBe(false);
  });

  it("passkey register options accepts a valid body and rejects extra keys and wrong type", () => {
    expect(passkeyRegisterOptionsBody.safeParse({}).success).toBe(true);
    expect(opsPasskeyRegisterOptionsBody.safeParse({}).success).toBe(true);

    expect(passkeyRegisterOptionsBody.safeParse({ extra: 1 }).success).toBe(false);
    expect(passkeyRegisterOptionsBody.safeParse("not an object").success).toBe(false);
  });

  it("passkey register verify accepts a valid body and rejects extra, missing, and wrong type", () => {
    const valid = {
      clientDataJSON: "base64url-clientData",
      attestationObject: "base64url-attestation",
    };
    expect(passkeyRegisterVerifyBody.safeParse(valid).success).toBe(true);
    expect(opsPasskeyRegisterVerifyBody.safeParse(valid).success).toBe(true);

    expect(passkeyRegisterVerifyBody.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(
      passkeyRegisterVerifyBody.safeParse({ clientDataJSON: "base64url-clientData" }).success,
    ).toBe(false);
    expect(
      passkeyRegisterVerifyBody.safeParse({
        clientDataJSON: 123,
        attestationObject: "base64url-attestation",
      }).success,
    ).toBe(false);
    expect(
      passkeyRegisterVerifyBody.safeParse({
        clientDataJSON: "",
        attestationObject: "base64url-attestation",
      }).success,
    ).toBe(false);
  });

  it("passkey authenticate options accepts a valid body and rejects extra keys and wrong type", () => {
    expect(passkeyAuthenticateOptionsBody.safeParse({}).success).toBe(true);
    expect(opsPasskeyAuthenticateOptionsBody.safeParse({}).success).toBe(true);

    expect(passkeyAuthenticateOptionsBody.safeParse({ extra: 1 }).success).toBe(false);
    expect(passkeyAuthenticateOptionsBody.safeParse(123).success).toBe(false);
  });

  it("passkey authenticate verify accepts a valid body and rejects extra, missing, and wrong type", () => {
    const valid = {
      credentialId: "base64url-credId",
      clientDataJSON: "base64url-clientData",
      authenticatorData: "base64url-authData",
      signature: "base64url-sig",
    };
    expect(passkeyAuthenticateVerifyBody.safeParse(valid).success).toBe(true);
    expect(opsPasskeyAuthenticateVerifyBody.safeParse(valid).success).toBe(true);

    expect(passkeyAuthenticateVerifyBody.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(
      passkeyAuthenticateVerifyBody.safeParse({
        credentialId: "base64url-credId",
        clientDataJSON: "base64url-clientData",
        authenticatorData: "base64url-authData",
      }).success,
    ).toBe(false);
    expect(
      passkeyAuthenticateVerifyBody.safeParse({
        ...valid,
        signature: 12345,
      }).success,
    ).toBe(false);
    expect(
      passkeyAuthenticateVerifyBody.safeParse({
        ...valid,
        credentialId: "",
      }).success,
    ).toBe(false);
  });

  it("session refresh accepts a valid body and rejects extra keys and wrong type", () => {
    expect(sessionRefreshBody.safeParse({}).success).toBe(true);
    expect(opsSessionRefreshBody.safeParse({}).success).toBe(true);

    expect(sessionRefreshBody.safeParse({ extra: 1 }).success).toBe(false);
    expect(sessionRefreshBody.safeParse(null).success).toBe(false);
  });

  it("session end accepts a valid body and rejects extra keys and wrong type", () => {
    expect(sessionEndBody.safeParse({}).success).toBe(true);
    expect(opsSessionEndBody.safeParse({}).success).toBe(true);

    expect(sessionEndBody.safeParse({ extra: 1 }).success).toBe(false);
    expect(sessionEndBody.safeParse(false).success).toBe(false);
  });
});

describe("ops response schemas", () => {
  it("expiresIn accepts non-negative integers and rejects negatives, floats, extra keys, and wrong types", () => {
    expect(expiresInResponse.safeParse({ expiresIn: 900 }).success).toBe(true);
    expect(expiresInResponse.safeParse({ expiresIn: 0 }).success).toBe(true);
    expect(opsExpiresInResponse.safeParse({ expiresIn: 900 }).success).toBe(true);

    expect(expiresInResponse.safeParse({ expiresIn: -1 }).success).toBe(false);
    expect(expiresInResponse.safeParse({ expiresIn: 12.34 }).success).toBe(false);
    expect(expiresInResponse.safeParse({ expiresIn: 900, extra: 1 }).success).toBe(false);
    expect(expiresInResponse.safeParse({}).success).toBe(false);
    expect(expiresInResponse.safeParse({ expiresIn: "900" }).success).toBe(false);
  });

  it("enrolment status accepts enrolment and activated and rejects other values, extra keys, and wrong types", () => {
    expect(enrolmentStatusResponse.safeParse({ status: "enrolment" }).success).toBe(true);
    expect(enrolmentStatusResponse.safeParse({ status: "activated" }).success).toBe(true);
    expect(opsEnrolmentStatusResponse.safeParse({ status: "enrolment" }).success).toBe(true);

    expect(enrolmentStatusResponse.safeParse({ status: "pending" }).success).toBe(false);
    expect(enrolmentStatusResponse.safeParse({ status: "enrolment", extra: 1 }).success).toBe(
      false,
    );
    expect(enrolmentStatusResponse.safeParse({}).success).toBe(false);
    expect(enrolmentStatusResponse.safeParse({ status: 123 }).success).toBe(false);
  });

  it("activated accepts booleans and rejects extra keys, missing keys, and wrong types", () => {
    expect(activatedResponse.safeParse({ activated: true }).success).toBe(true);
    expect(activatedResponse.safeParse({ activated: false }).success).toBe(true);
    expect(opsActivatedResponse.safeParse({ activated: true }).success).toBe(true);

    expect(activatedResponse.safeParse({ activated: true, extra: 1 }).success).toBe(false);
    expect(activatedResponse.safeParse({}).success).toBe(false);
    expect(activatedResponse.safeParse({ activated: "true" }).success).toBe(false);
  });

  it("roles accepts array of strings and rejects extra keys, missing keys, and wrong element types", () => {
    expect(rolesResponse.safeParse({ roles: ["platform_admin", "platform_support"] }).success).toBe(
      true,
    );
    expect(rolesResponse.safeParse({ roles: [] }).success).toBe(true);
    expect(opsRolesResponse.safeParse({ roles: ["platform_admin"] }).success).toBe(true);
    expect(opsMeResponse.safeParse({ roles: ["platform_admin"] }).success).toBe(true);

    expect(rolesResponse.safeParse({ roles: [], extra: 1 }).success).toBe(false);
    expect(rolesResponse.safeParse({}).success).toBe(false);
    expect(rolesResponse.safeParse({ roles: [123] }).success).toBe(false);
    expect(rolesResponse.safeParse({ roles: "admin" }).success).toBe(false);
  });

  it("directory accepts valid organisations and communities and enforces strictness", () => {
    const valid = {
      organisations: [
        {
          id: "org-1",
          slug: "acme",
          kind: "charity",
          region: "ap-southeast-2",
          communities: [
            { id: "comm-1", slug: "parish-a" },
            { id: "comm-2", slug: "parish-b" },
          ],
        },
      ],
      truncated: false,
    };
    expect(directoryResponse.safeParse(valid).success).toBe(true);
    expect(opsDirectoryResponse.safeParse(valid).success).toBe(true);
    expect(directoryResponse.safeParse({ organisations: [], truncated: true }).success).toBe(true);

    // Root extra key
    expect(directoryResponse.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    // Missing truncated
    expect(directoryResponse.safeParse({ organisations: valid.organisations }).success).toBe(false);
    // Missing organisations
    expect(directoryResponse.safeParse({ truncated: false }).success).toBe(false);
    // Extra key in organisation
    expect(
      directoryResponse.safeParse({
        organisations: [
          {
            ...valid.organisations[0],
            extra: 1,
          },
        ],
        truncated: false,
      }).success,
    ).toBe(false);
    // Missing key in organisation (e.g. region)
    expect(
      directoryResponse.safeParse({
        organisations: [
          {
            id: "org-1",
            slug: "acme",
            kind: "charity",
            communities: [],
          },
        ],
        truncated: false,
      }).success,
    ).toBe(false);
    // Extra key in community
    expect(
      directoryResponse.safeParse({
        organisations: [
          {
            id: "org-1",
            slug: "acme",
            kind: "charity",
            region: "ap-southeast-2",
            communities: [{ id: "comm-1", slug: "parish-a", extra: 1 }],
          },
        ],
        truncated: false,
      }).success,
    ).toBe(false);
    // Missing key in community
    expect(
      directoryResponse.safeParse({
        organisations: [
          {
            id: "org-1",
            slug: "acme",
            kind: "charity",
            region: "ap-southeast-2",
            communities: [{ id: "comm-1" }],
          },
        ],
        truncated: false,
      }).success,
    ).toBe(false);
    // Wrong types
    expect(directoryResponse.safeParse({ organisations: "none", truncated: false }).success).toBe(
      false,
    );
    expect(directoryResponse.safeParse({ organisations: [], truncated: "false" }).success).toBe(
      false,
    );
  });

  it("passkey register options accepts a full valid body, accepts excludeCredentials as empty, and rejects invalid structures", () => {
    const valid = {
      challenge: "AQID",
      rp: {
        id: "ops.example.test",
        name: "Community Hub operations",
      },
      user: {
        id: "AQID",
        name: "Community Hub operator",
        displayName: "Community Hub operator",
      },
      pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }],
      attestation: "none" as const,
      authenticatorSelection: {
        userVerification: "preferred" as const,
        residentKey: "required" as const,
      },
      excludeCredentials: [{ type: "public-key" as const, id: "AQID" }],
    };

    expect(passkeyRegisterOptionsResponse.safeParse(valid).success).toBe(true);
    expect(opsPasskeyRegisterOptionsResponse.safeParse(valid).success).toBe(true);
    expect(
      passkeyRegisterOptionsResponse.safeParse({ ...valid, excludeCredentials: [] }).success,
    ).toBe(true);

    // missing rp.name
    expect(
      passkeyRegisterOptionsResponse.safeParse({
        ...valid,
        rp: { id: valid.rp.id },
      }).success,
    ).toBe(false);

    // missing excludeCredentials
    const withoutExcludeCredentials: Record<string, unknown> = { ...valid };
    delete withoutExcludeCredentials.excludeCredentials;
    expect(passkeyRegisterOptionsResponse.safeParse(withoutExcludeCredentials).success).toBe(false);

    // an extra top-level key
    expect(
      passkeyRegisterOptionsResponse.safeParse({
        ...valid,
        extra: 1,
      }).success,
    ).toBe(false);

    // an extra key inside rp
    expect(
      passkeyRegisterOptionsResponse.safeParse({
        ...valid,
        rp: { ...valid.rp, extra: 1 },
      }).success,
    ).toBe(false);

    // attestation: "direct"
    expect(
      passkeyRegisterOptionsResponse.safeParse({
        ...valid,
        attestation: "direct",
      }).success,
    ).toBe(false);

    // residentKey: "preferred"
    expect(
      passkeyRegisterOptionsResponse.safeParse({
        ...valid,
        authenticatorSelection: {
          ...valid.authenticatorSelection,
          residentKey: "preferred",
        },
      }).success,
    ).toBe(false);
  });

  it("passkey authenticate options passes with and without userVerification, and rejects preferred or extra keys", () => {
    const valid = {
      challenge: "AQID",
      rpId: "ops.example.test",
    };

    expect(passkeyAuthenticateOptionsResponse.safeParse(valid).success).toBe(true);
    expect(opsPasskeyAuthenticateOptionsResponse.safeParse(valid).success).toBe(true);
    expect(
      passkeyAuthenticateOptionsResponse.safeParse({
        ...valid,
        userVerification: "required",
      }).success,
    ).toBe(true);
    expect(
      opsPasskeyAuthenticateOptionsResponse.safeParse({
        ...valid,
        userVerification: "required",
      }).success,
    ).toBe(true);

    expect(
      passkeyAuthenticateOptionsResponse.safeParse({
        ...valid,
        userVerification: "preferred",
      }).success,
    ).toBe(false);
    expect(
      passkeyAuthenticateOptionsResponse.safeParse({
        ...valid,
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
