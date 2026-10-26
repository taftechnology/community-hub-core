import { sqlstate } from "./db-ops-error.js";

/**
 * The one fixed secret this command reads: a Secrets Manager secret whose
 * resource name ends with `-provision-owner-` plus the six-character random
 * suffix Secrets Manager appends. `${name}` is not known at runtime, so the
 * check is on the `-provision-owner-??????` tail, not a fully-known literal.
 */
export const PROVISION_SECRET_ARN =
  /^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[^\s:]+-provision-owner-[A-Za-z0-9]{6}$/;

/** Node/postgres.js connection-level error codes that are a `connect` failure, not `fail`. */
export const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

/** The adapter wraps every envelope-key failure as `Error("kms_failed")`. */
export function isKmsFailure(error: unknown): boolean {
  return error instanceof Error && error.message === "kms_failed";
}

/** True when the error (or a cause one level down) carries a connection-level code. */
export function isConnectionError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_CODES.has(code)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The failure word for an uncaught error, reading nothing from the error but its
 * class of failure. `kms` for an envelope-key failure, `connect`/`connect <SQLSTATE>`
 * for a database connection failure, `fail` for anything else.
 */
export function classify(error: unknown): string {
  if (isKmsFailure(error)) {
    return "kms\n";
  }
  const code = sqlstate(error);
  if (code !== undefined) {
    return `connect ${code}\n`;
  }
  if (isConnectionError(error)) {
    return "connect\n";
  }
  return "fail\n";
}
