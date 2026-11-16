export type AccessErrorCode =
  | "invalid_id"
  | "invalid_role"
  | "invalid_permission"
  | "not_found"
  | "forbidden"
  | "minor_forbidden"
  | "duplicate_link"
  | "duplicate_grant"
  | "duplicate_role"
  | "already_bootstrapped"
  | "last_owner"
  | "limit_reached"
  | "role_in_use"
  | "too_many"
  | "not_member"
  | "already_invited"
  | "invitation_invalid"
  | "wrong_address"
  | "invitation_void"
  | "invitation_not_found"
  | "person_linked"
  | "person_minor"
  | "person_not_found"
  | "role_not_found";

export class AccessError extends Error {
  readonly code: AccessErrorCode;

  constructor(code: AccessErrorCode) {
    super(code);
    this.name = "AccessError";
    this.code = code;
  }
}
