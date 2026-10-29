export type PeopleErrorCode =
  | "invalid_date"
  | "invalid_declaration"
  | "invalid_name"
  | "invalid_email"
  | "invalid_phone"
  | "invalid_tag"
  | "invalid_guardian"
  | "household_required"
  | "duplicate_email"
  | "duplicate_phone"
  | "duplicate_tag"
  | "duplicate_guardian_link"
  | "not_found"
  | "invalid_input";

export class PeopleError extends Error {
  readonly code: PeopleErrorCode;

  constructor(code: PeopleErrorCode) {
    super(code);
    this.name = "PeopleError";
    this.code = code;
  }
}
