export { IdentityError } from "../domain/error.js";
export { OtpMailUnavailable, rejectingOtpMail, type OtpMail } from "../domain/otp-mail.js";
export { startEmailOtp, verifyEmailOtp } from "../infrastructure/email-otp.js";
export { ensureIdentityKey } from "../infrastructure/identity-key.js";
export {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
} from "../infrastructure/passkey.js";
