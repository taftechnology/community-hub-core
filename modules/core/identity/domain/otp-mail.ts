import { IdentityError } from "./error.js";

export type OtpMail = {
  send(input: { to: string; code: string }): Promise<void>;
};

export class OtpMailUnavailable extends IdentityError {
  constructor() {
    super("email_unavailable");
    this.name = "OtpMailUnavailable";
  }
}

export const rejectingOtpMail: OtpMail = {
  send() {
    return Promise.reject(new OtpMailUnavailable());
  },
};
