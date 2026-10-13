export { IdentityError } from "../domain/error.js";
export { OtpMailUnavailable, rejectingOtpMail, type OtpMail } from "../domain/otp-mail.js";
export { startEmailOtp, verifyEmailOtp } from "../infrastructure/email-otp.js";
export { ensureIdentityKey } from "../infrastructure/identity-key.js";
export { findOrCreateUserByEmail, findUserByEmail } from "../infrastructure/email-lookup.js";
export {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
} from "../infrastructure/passkey.js";
export { readSession, refreshSession, type SessionTokens } from "../infrastructure/session.js";
