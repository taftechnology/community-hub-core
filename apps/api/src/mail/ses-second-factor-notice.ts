import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  SecondFactorNoticeUnavailable,
  type SecondFactorNotice,
  type SecondFactorNoticeKind,
} from "@community-hub/identity";
import { DEFAULT_DEADLINE_MS, type SesClientLike, type SesInfoFields } from "./ses-otp-mail.js";

export { DEFAULT_DEADLINE_MS, type SesClientLike, type SesInfoFields };

const SUBJECT = "Your Community Hub sign-in methods changed";
const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const NOTICE_TEXT_BY_KIND: Record<SecondFactorNoticeKind, string> = {
  totp_set_up: "An authenticator app was set up for your Community Hub account",
  totp_removed: "The authenticator app was removed from your Community Hub account",
  passkey_added: "A passkey was added to your Community Hub account",
  passkey_removed: "A passkey was removed from your Community Hub account",
  backup_codes_made: "New backup codes were generated for your Community Hub account",
};

function errorClassOf(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error)) {
      return undefined;
    }
    const name: unknown = error.name;
    return typeof name === "string" && ERROR_CLASS.test(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

class TimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

function noticeBody(kind: SecondFactorNoticeKind, now: Date): string {
  return `${NOTICE_TEXT_BY_KIND[kind]} at ${now.toISOString()}. If this wasn't you, contact your organisation's owner.`;
}

export function createSesSecondFactorNotice(options: {
  client: () => SesClientLike;
  from: string;
  configurationSet: string;
  deadlineMs?: number;
  now?: () => Date;
  info: (fields: SesInfoFields) => void;
}): SecondFactorNotice {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const now = options.now ?? (() => new Date());

  return {
    async send({ to, kind }): Promise<void> {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        const sesClient = options.client();
        const command = new SendEmailCommand({
          FromEmailAddress: options.from,
          Destination: {
            ToAddresses: [to],
          },
          ConfigurationSetName: options.configurationSet,
          Content: {
            Simple: {
              Subject: {
                Data: SUBJECT,
              },
              Body: {
                Text: {
                  Data: noticeBody(kind, now()),
                },
              },
            },
          },
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new TimeoutError());
          }, deadlineMs);
        });

        const sendPromise = sesClient.send(command, { abortSignal: controller.signal });
        sendPromise.catch(() => {});

        await Promise.race([sendPromise, timeoutPromise]);
        clearTimeout(timer);
        options.info({ operation: "send_email", outcome: "ok" });
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof TimeoutError) {
          options.info({ operation: "send_email", outcome: "timeout" });
        } else {
          const errorClass = errorClassOf(error);
          const fields: SesInfoFields = {
            operation: "send_email",
            outcome: "failed",
          };
          if (errorClass !== undefined) {
            fields.errorClass = errorClass;
          }
          options.info(fields);
        }
        throw new SecondFactorNoticeUnavailable();
      }
    },
  };
}
