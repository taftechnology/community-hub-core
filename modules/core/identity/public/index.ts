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
  beginOperatorAuthentication,
  beginOperatorPasskeyRegistration,
  endOperatorSession,
  finishOperatorAuthentication,
  finishOperatorPasskeyRegistration,
  grantOperator,
  readOperatorSession,
  recoverOperator,
  refreshOperatorSession,
  revokeOperator,
  startOperatorEnrolment,
  verifyOperatorEnrolment,
  type BeginOperatorAuthenticationInput,
  type BeginOperatorPasskeyRegistrationInput,
  type EndOperatorSessionInput,
  type FinishOperatorAuthenticationInput,
  type FinishOperatorPasskeyRegistrationInput,
  type GrantOperatorInput,
  type ReadOperatorSessionInput,
  type RecoverOperatorInput,
  type RefreshOperatorSessionInput,
  type RevokeOperatorInput,
  type StartOperatorEnrolmentInput,
  type VerifyOperatorEnrolmentInput,
  type VerifyOperatorEnrolmentResult,
} from "../infrastructure/operator.js";
