export type EntitlementErrorCode =
  | "invalid_key"
  | "invalid_limit"
  | "invalid_region"
  | "invalid_expiry"
  | "not_found"
  | "duplicate_allocation"
  | "not_allocated";

export class EntitlementError extends Error {
  readonly code: EntitlementErrorCode;

  constructor(code: EntitlementErrorCode) {
    super(code);
    this.name = "EntitlementError";
    this.code = code;
  }
}
