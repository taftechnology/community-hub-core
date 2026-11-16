import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { InvitationMailUnavailable, type InvitationMail } from "@community-hub/access";

export const DEFAULT_DEADLINE_MS = 5000;

export type SesOperation = "send_email";
export type SesOutcome = "ok" | "failed" | "timeout";

export type SesInfoFields = {
  operation: SesOperation;
  outcome: SesOutcome;
  errorClass?: string;
};

export type SesClientLike = {
  send: (
    command: SendEmailCommand,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<{ MessageId?: string } | unknown>;
};

class TimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

export function createSesInvitationMail(options: {
  client: () => SesClientLike;
  from: string;
  configurationSet: string;
  deadlineMs?: number;
  info?: (fields: SesInfoFields) => void;
}): InvitationMail {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;

  return {
    async send({ to, communitySlug, link, expiresAt }): Promise<void> {
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
                Data: `You're invited to ${communitySlug} on Community Hub`,
              },
              Body: {
                Text: {
                  Data: `You're invited to ${communitySlug} on Community Hub. Accept your invitation by ${expiresAt.toISOString()} using the following link:\n\n${link}\n\nIf you weren't expecting this, you can ignore it.`,
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
        options.info?.({ operation: "send_email", outcome: "ok" });
      } catch {
        clearTimeout(timer);
        controller.abort();
        // Nothing is logged on failure.
        throw new InvitationMailUnavailable();
      }
    },
  };
}
