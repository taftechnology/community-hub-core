export type LogFields = {
  method?: string;
  path?: string;
  status?: number;
  duration?: number;
  requestId?: string;
};

type LogFieldKey = keyof LogFields;

/** Rejects `Record<string, unknown>` and other wide key sets at compile time. */
type StrictLogFields<T extends LogFields> = [keyof T] extends [LogFieldKey]
  ? T
  : never;

export type CreateLoggerOptions = {
  write?: (line: string) => void;
};

export type Logger = {
  info: <T extends LogFields>(
    message: string,
    fields?: StrictLogFields<T>,
  ) => void;
  getDroppedFieldCount: () => number;
};

const ALLOWED_LOG_KEYS: ReadonlySet<LogFieldKey> = new Set([
  "method",
  "path",
  "status",
  "duration",
  "requestId",
]);

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
      default: {
        dropped += 1;
      }
    }
  }

  return { fields, dropped };
}

function formatLogLine(
  level: string,
  message: string,
  fields: LogFields,
): string {
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
