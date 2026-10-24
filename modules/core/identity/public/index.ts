export { IdentityError } from "../domain/error.js";
export { OtpMailUnavailable, rejectingOtpMail, type OtpMail } from "../domain/otp-mail.js";
export { startEmailOtp, verifyEmailOtp, type OtpPurpose } from "../infrastructure/email-otp.js";
export { ensureIdentityKey } from "../infrastructure/identity-key.js";
export { findOrCreateUserByEmail, findUserByEmail } from "../infrastructure/email-lookup.js";
export {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  verifyPasskeyAssertion,
  type PasskeyAuthenticationOptions,
  type PasskeyBeforeStore,
  type PasskeyOnStored,
  type PasskeyRegistrationOnStored,
  type PasskeyRegistrationOptions,
} from "../infrastructure/passkey.js";
export {
  readSession,
  readSessionWithKind,
  refreshSession,
  type RefreshCheck,
  type SessionKind,
  type SessionTokens,
} from "../infrastructure/session.js";
export {
  grantOperator,
  recoverOperator,
  revokeOperator,
  type GrantOperatorInput,
  type RecoverOperatorInput,
  type RevokeOperatorInput,
} from "../infrastructure/operator.js";
