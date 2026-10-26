import { z } from "zod";

const bytes = z.string().min(1);

export const enrolmentStartBody = z.strictObject({
  email: z.string().min(1),
});
export const opsEnrolmentStartBody = enrolmentStartBody;

export const enrolmentVerifyBody = z.strictObject({
  email: z.string().min(1),
  emailCode: z.string().min(1),
  enrolmentCode: z.string().min(1),
});
export const opsEnrolmentVerifyBody = enrolmentVerifyBody;

export const passkeyRegisterOptionsBody = z.strictObject({});
export const opsPasskeyRegisterOptionsBody = passkeyRegisterOptionsBody;

export const passkeyRegisterVerifyBody = z.strictObject({
  clientDataJSON: bytes,
  attestationObject: bytes,
});
export const opsPasskeyRegisterVerifyBody = passkeyRegisterVerifyBody;

export const passkeyAuthenticateOptionsBody = z.strictObject({});
export const opsPasskeyAuthenticateOptionsBody = passkeyAuthenticateOptionsBody;

export const passkeyAuthenticateVerifyBody = z.strictObject({
  credentialId: bytes,
  clientDataJSON: bytes,
  authenticatorData: bytes,
  signature: bytes,
});
export const opsPasskeyAuthenticateVerifyBody = passkeyAuthenticateVerifyBody;

export const sessionRefreshBody = z.strictObject({});
export const opsSessionRefreshBody = sessionRefreshBody;

export const sessionEndBody = z.strictObject({});
export const opsSessionEndBody = sessionEndBody;

export const expiresInResponse = z.strictObject({
  expiresIn: z.number().int().nonnegative(),
});
export const opsExpiresInResponse = expiresInResponse;

export const enrolmentStatusResponse = z.strictObject({
  status: z.enum(["enrolment", "activated"]),
});
export const opsEnrolmentStatusResponse = enrolmentStatusResponse;
export const enrolmentVerifyResponse = enrolmentStatusResponse;
export const opsEnrolmentVerifyResponse = enrolmentStatusResponse;

export const activatedResponse = z.strictObject({
  activated: z.boolean(),
});
export const opsActivatedResponse = activatedResponse;
export const passkeyRegisterVerifyResponse = activatedResponse;
export const opsPasskeyRegisterVerifyResponse = activatedResponse;

export const passkeyRegisterOptionsResponse = z.strictObject({
  challenge: bytes,
  rp: z.strictObject({
    id: z.string(),
    name: z.string(),
  }),
  user: z.strictObject({
    id: bytes,
    name: z.string(),
    displayName: z.string(),
  }),
  pubKeyCredParams: z.array(
    z.strictObject({
      type: z.literal("public-key"),
      alg: z.number().int(),
    }),
  ),
  attestation: z.literal("none"),
  authenticatorSelection: z.strictObject({
    userVerification: z.enum(["preferred", "required"]),
    residentKey: z.literal("required"),
  }),
  excludeCredentials: z.array(
    z.strictObject({
      type: z.literal("public-key"),
      id: bytes,
    }),
  ),
});
export const opsPasskeyRegisterOptionsResponse = passkeyRegisterOptionsResponse;
export type PasskeyRegisterOptionsResponse = z.infer<typeof passkeyRegisterOptionsResponse>;

export const passkeyAuthenticateOptionsResponse = z.strictObject({
  challenge: bytes,
  rpId: z.string(),
  userVerification: z.literal("required").optional(),
});
export const opsPasskeyAuthenticateOptionsResponse = passkeyAuthenticateOptionsResponse;
export type PasskeyAuthenticateOptionsResponse = z.infer<typeof passkeyAuthenticateOptionsResponse>;

export const rolesResponse = z.strictObject({
  roles: z.array(z.string()),
});
export const opsRolesResponse = rolesResponse;
export const meResponse = rolesResponse;
export const opsMeResponse = rolesResponse;

export const directoryCommunitySchema = z.strictObject({
  id: z.string(),
  slug: z.string(),
});

export const directoryOrganisationSchema = z.strictObject({
  id: z.string(),
  slug: z.string(),
  kind: z.string(),
  region: z.string(),
  communities: z.array(directoryCommunitySchema),
});

export const directoryResponse = z.strictObject({
  organisations: z.array(directoryOrganisationSchema),
  truncated: z.boolean(),
});
export const opsDirectoryResponse = directoryResponse;
