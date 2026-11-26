import { z } from "zod";

const bytes = z.string().min(1);

export const secondFactorMethod = z.enum(["totp", "passkey", "backup_code"]);

export const startEmailOtpBody = z.strictObject({
  email: z.string().min(1),
});

export const verifyEmailOtpBody = z.strictObject({
  email: z.string().min(1),
  code: z.string().regex(/^\d{8}$/),
});

export const verifyEmailOtpAnswer = z.strictObject({
  secondFactor: z.enum(["verify", "setup"]),
  methods: z.array(secondFactorMethod),
  passkeysAvailable: z.boolean(),
  accessToken: bytes,
  expiresIn: z.number().int().positive(),
});

const adminSessionFields = {
  userId: bytes,
  accessToken: bytes,
  refreshToken: bytes,
  expiresIn: z.number().int().positive(),
};

export const adminSessionAnswer = z.strictObject(adminSessionFields);

export const secondFactorVerifyBody = z.strictObject({
  method: z.enum(["totp", "backup_code"]),
  code: z.string().min(1),
});

export const secondFactorVerifyAnswer = z.strictObject({
  ...adminSessionFields,
  backupCodesLeft: z.number().int().nonnegative().optional(),
});

export const secondFactorPasskeyOptionsBody = z.strictObject({});

export const passkeyRegisterOptionsBody = z.strictObject({});

export const passkeyRegisterOptionsAnswer = z.strictObject({
  challenge: bytes,
  rp: z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
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

export const passkeyRegisterVerifyBody = z.strictObject({
  clientDataJSON: bytes,
  attestationObject: bytes,
});

export const passkeyAuthenticateOptionsBody = z.strictObject({});

export const passkeyAuthenticateOptionsAnswer = z.strictObject({
  challenge: bytes,
  rpId: z.string().min(1),
  userVerification: z.literal("required"),
});

export const passkeyAuthenticateVerifyBody = z.strictObject({
  credentialId: bytes,
  clientDataJSON: bytes,
  authenticatorData: bytes,
  signature: bytes,
});

export const secondFactorPasskeyVerifyBody = passkeyAuthenticateVerifyBody;

export const refreshSessionBody = z.strictObject({
  refreshToken: bytes,
});

export const endSessionBody = z.strictObject({});

export const totpStartBody = z.strictObject({});

export const totpStartAnswer = z.strictObject({
  secret: z.string().min(1),
  otpauthUri: z.string().min(1),
});

export const totpConfirmBody = z.strictObject({
  code: z.string().min(1),
});

export const firstFactorBackupCodesAnswer = z.strictObject({
  backupCodes: z.array(z.string().min(1)),
  ...adminSessionFields,
});

export const freshTotpBody = z.strictObject({
  code: z.string().min(1),
});

export const freshPasskeyOptionsBody = z.strictObject({});

export const freshPasskeyVerifyBody = passkeyAuthenticateVerifyBody;

export const secondFactorListAnswer = z.strictObject({
  totp: z
    .strictObject({
      confirmedAt: z.string().datetime(),
    })
    .nullable(),
  passkeys: z.array(
    z.strictObject({
      id: z.string().uuid(),
      createdAt: z.string().datetime().nullable(),
    }),
  ),
  backupCodesLeft: z.number().int().nonnegative(),
  freshUntil: z.string().datetime().nullable(),
});

export const removeTotpBody = z.strictObject({});

export const removePasskeyBody = z.strictObject({
  passkeyId: z.string().min(1),
});

export const regenerateBackupCodesBody = z.strictObject({});

export const regenerateBackupCodesAnswer = z.strictObject({
  backupCodes: z.array(z.string().min(1)),
});
