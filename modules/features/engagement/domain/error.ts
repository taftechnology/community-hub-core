export type ServiceTimesErrorCode = "version_conflict" | "invalid_input";

export class ServiceTimesError extends Error {
  readonly code: ServiceTimesErrorCode;

  constructor(code: ServiceTimesErrorCode) {
    super(code);
    this.name = "ServiceTimesError";
    this.code = code;
  }
}
