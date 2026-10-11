export type IdentityErrorCode = "invalid_email" | "email_unavailable" | "invalid_ceremony";

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode) {
    super(code);
    this.name = "IdentityError";
    this.code = code;
  }
}
