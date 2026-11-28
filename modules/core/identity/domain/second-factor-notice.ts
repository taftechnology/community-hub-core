import { IdentityError } from "./error.js";

export type SecondFactorNoticeKind =
  "totp_set_up" | "totp_removed" | "passkey_added" | "passkey_removed" | "backup_codes_made";

export type SecondFactorNotice = {
  send(input: { to: string; kind: SecondFactorNoticeKind }): Promise<void>;
};

export class SecondFactorNoticeUnavailable extends IdentityError {
  constructor() {
    super("email_unavailable");
    this.name = "SecondFactorNoticeUnavailable";
  }
}

export const rejectingSecondFactorNotice: SecondFactorNotice = {
  send() {
    return Promise.reject(new SecondFactorNoticeUnavailable());
  },
};
