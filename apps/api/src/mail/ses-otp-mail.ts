import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { OtpMailUnavailable, type OtpMail } from "@community-hub/identity";

export const DEFAULT_DEADLINE_MS = 5000;

export type SesOperation = "send_email";
export type SesOutcome = "ok" | "failed" | "timeout";

export type SesInfoFields = {
  operation: SesOperation;
  outcome: SesOutcome;
  /** Class name of the caught error. Set only when the outcome is `failed`. */
  errorClass?: string;
};

export type SesClientLike = {
  send: (
    command: SendEmailCommand,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<{ MessageId?: string } | unknown>;
};

const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * The caught error's class name and nothing else. The message can hold sensitive data, so it
 * is never read. A thrown non-Error has no class.
 */
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

export function createSesOtpMail(options: {
  client: () => SesClientLike;
  from: string;
  configurationSet: string;
  deadlineMs?: number;
  info: (fields: SesInfoFields) => void;
}): OtpMail {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;

  return {
    async send({ to, code }): Promise<void> {
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
                Data: "Your sign-in code",
              },
              Body: {
                Text: {
                  Data: `Your sign-in code is ${code}. It expires in 10 minutes. If you did not request this code, you can safely ignore this email.`,
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
        throw new OtpMailUnavailable();
      }
    },
  };
}
