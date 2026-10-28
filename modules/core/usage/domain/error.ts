export type UsageErrorCode = "invalid_feature_key" | "invalid_time";

export class UsageError extends Error {
  readonly code: UsageErrorCode;

  constructor(code: UsageErrorCode) {
    super(code);
    this.name = "UsageError";
    this.code = code;
  }
}
