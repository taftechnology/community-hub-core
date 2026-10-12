const SQLSTATE = /^[0-9A-Z]{5}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A five-character SQLSTATE from a Postgres error, or undefined.
 *
 * The carrier is the error when it has a string `code`, else its `cause`, one
 * level only. A code counts only when the carrier is a PostgresError (by
 * `name`, or by the presence of `severity`, whose value is never read), because
 * Node errno codes such as EPIPE match the SQLSTATE pattern. Nothing else on
 * the error is read: not `message`, `query`, `params` or `stack`.
 */
export function sqlstate(error: unknown): string | undefined {
  if (!isObject(error)) {
    return undefined;
  }
  let carrier: Record<string, unknown> = error;
  if (typeof carrier.code !== "string") {
    const cause = carrier.cause;
    if (!isObject(cause)) {
      return undefined;
    }
    carrier = cause;
  }
  const code = carrier.code;
  if (typeof code !== "string" || !SQLSTATE.test(code)) {
    return undefined;
  }
  if (carrier.name !== "PostgresError" && !("severity" in carrier)) {
    return undefined;
  }
  return code;
}

/** `connect`, `migrate`, `connect 28P01` or `migrate 42501`, with a newline. */
export function failureLine(stage: "connect" | "migrate", error: unknown): string {
  const code = sqlstate(error);
  return code === undefined ? `${stage}\n` : `${stage} ${code}\n`;
}
