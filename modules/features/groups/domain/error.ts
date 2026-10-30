export type GroupsErrorCode =
  | "duplicate_name"
  | "already_member"
  | "person_not_found"
  | "group_not_found"
  | "group_archived"
  | "invalid_input";

export class GroupsError extends Error {
  readonly code: GroupsErrorCode;

  constructor(code: GroupsErrorCode) {
    super(code);
    this.name = "GroupsError";
    this.code = code;
  }
}
