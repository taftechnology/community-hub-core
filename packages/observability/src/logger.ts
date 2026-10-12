export type LogReason =
  | "missing_hostname_header"
  | "unknown_hostname"
  | "ops_route_on_other_hostname"
  | "other_route_on_ops_hostname";

export type LogOperation = "generate_data_key" | "decrypt";

export type LogKeyKind = "org" | "identity";

export type LogOutcome = "ok" | "rejected" | "failed" | "timeout";

export type LogFields = {
  method?: string;
  path?: string;
  status?: number;
  duration?: number;
  requestId?: string;
  gatewayRequestId?: string;
  reason?: LogReason;
  hostname?: string;
  operation?: LogOperation;
  key_kind?: LogKeyKind;
  outcome?: LogOutcome;
  /** A thrown error's class name. Anything that is not a plain identifier is logged as `Error`. */
  errorClass?: string;
  /** A short upper-case error code, such as a SQLSTATE or a Node errno code. */
  errorCode?: string;
};

type LogFieldKey = keyof LogFields;

/** Rejects `Record<string, unknown>` and other wide key sets at compile time. */
type StrictLogFields<T extends LogFields> = [keyof T] extends [LogFieldKey] ? T : never;

export type CreateLoggerOptions = {
  write?: (line: string) => void;
};

export type Logger = {
  info: <T extends LogFields>(message: string, fields?: StrictLogFields<T>) => void;
  getDroppedFieldCount: () => number;
};

const ALLOWED_LOG_KEYS: ReadonlySet<LogFieldKey> = new Set([
  "method",
  "path",
  "status",
  "duration",
  "requestId",
  "gatewayRequestId",
  "reason",
  "hostname",
  "operation",
  "key_kind",
  "outcome",
  "errorClass",
  "errorCode",
]);

const GATEWAY_REQUEST_ID = /^[A-Za-z0-9+/=_-]{1,128}$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ERROR_CODE = /^[A-Z0-9_]{1,40}$/;
const FALLBACK_ERROR_CLASS = "Error";
const REASONS = new Set<LogReason>([
  "missing_hostname_header",
  "unknown_hostname",
  "ops_route_on_other_hostname",
  "other_route_on_ops_hostname",
]);
const OPERATIONS = new Set<LogOperation>(["generate_data_key", "decrypt"]);
const KEY_KINDS = new Set<LogKeyKind>(["org", "identity"]);
const OUTCOMES = new Set<LogOutcome>(["ok", "rejected", "failed", "timeout"]);

function isOneOf<T extends string>(value: unknown, allowed: ReadonlySet<T>): value is T {
  return typeof value === "string" && allowed.has(value as T);
}

/** Field names classified as personal data — never emitted (architecture §12). */
const PERSONAL_DATA_KEYS = new Set(["name", "email"]);

function isLogFieldKey(key: string): key is LogFieldKey {
  return ALLOWED_LOG_KEYS.has(key as LogFieldKey);
}

function sanitizeFields(raw: unknown): { fields: LogFields; dropped: number } {
  if (raw === null || raw === undefined) {
    return { fields: {}, dropped: 0 };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { fields: {}, dropped: 0 };
  }

  const fields: LogFields = {};
  let dropped = 0;

  for (const [key, value] of Object.entries(raw)) {
    if (PERSONAL_DATA_KEYS.has(key)) {
      dropped += 1;
      continue;
    }
    if (!isLogFieldKey(key)) {
      dropped += 1;
      continue;
    }

    switch (key) {
      case "status":
      case "duration": {
        if (typeof value === "number" && Number.isFinite(value)) {
          fields[key] = value;
        } else if (value !== undefined) {
          dropped += 1;
        }
        break;
      }
      case "method":
      case "path":
      case "requestId": {
        if (typeof value === "string") {
          fields[key] = value;
        } else if (value !== undefined) {
          dropped += 1;
        }
        break;
      }
      case "gatewayRequestId": {
        if (typeof value === "string" && GATEWAY_REQUEST_ID.test(value)) {
          fields.gatewayRequestId = value;
        } else if (value !== undefined) {
          dropped += 1;
        }
        break;
      }
      case "hostname": {
        if (typeof value === "string" && value.length <= 253 && HOSTNAME.test(value)) {
          fields.hostname = value;
        } else if (value !== undefined) {
          dropped += 1;
        }
        break;
      }
      case "reason": {
        if (isOneOf(value, REASONS)) {
          fields.reason = value;
        } else if (value !== undefined) {
          dropped += 1;
        }
        break;
      }
      case "operation": {
        if (isOneOf(value, OPERATIONS)) {
          fields.operation = value;
        } else if (value !== undefined) {
          dropped += 1;
        }
        break;
      }
      case "key_kind": {
        if (isOneOf(value, KEY_KINDS)) {
          fields.key_kind = value;
        } else if (value !== undefined) {
          dropped += 1;
        }
        break;
      }
      case "outcome": {
        if (isOneOf(value, OUTCOMES)) {
          fields.outcome = value;
        } else if (value !== undefined) {
          dropped += 1;
        }
        break;
      }
      case "errorClass": {
        if (typeof value === "string" && ERROR_CLASS.test(value)) {
          fields.errorClass = value;
        } else if (value !== undefined) {
          fields.errorClass = FALLBACK_ERROR_CLASS;
          dropped += 1;
        }
        break;
      }
      case "errorCode": {
        if (typeof value === "string" && ERROR_CODE.test(value)) {
          fields.errorCode = value;
        } else if (value !== undefined) {
          dropped += 1;
        }
        break;
      }
      default: {
        dropped += 1;
      }
    }
  }

  return { fields, dropped };
}

function formatLogLine(level: string, message: string, fields: LogFields): string {
  return JSON.stringify({ level, message, ...fields });
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => console.log(line));
  let droppedFieldCount = 0;

  return {
    info(message: string, rawFields?: LogFields) {
      try {
        const { fields, dropped } = sanitizeFields(rawFields);
        droppedFieldCount += dropped;
        write(formatLogLine("info", message, fields));
      } catch {
        try {
          write(formatLogLine("info", message, {}));
        } catch {
          // Logger must never throw in production.
        }
      }
    },
    getDroppedFieldCount() {
      return droppedFieldCount;
    },
  };
}
