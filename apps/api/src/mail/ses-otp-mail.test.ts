import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { OtpMailUnavailable } from "@community-hub/identity";
import { createSesOtpMail, type SesClientLike, type SesInfoFields } from "./ses-otp-mail.js";

describe("createSesOtpMail", () => {
  const from = "no-reply@mail.example.test";
  const configurationSet = "community-hub-otp";
  const to = "user@example.test";
  const code = "12345678";

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds command input field by field, subject has no code, body is text only with lifetime and ignore line, and logs ok", async () => {
    const commands: SendEmailCommand[] = [];
    const infoCalls: SesInfoFields[] = [];
    const client: SesClientLike = {
      send: vi.fn(async (command) => {
        commands.push(command);
        return { MessageId: "msg-12345" };
      }),
    };

    const mail = createSesOtpMail({
      client: () => client,
      from,
      configurationSet,
      info: (fields) => infoCalls.push(fields),
    });

    await mail.send({ to, code });

    expect(commands).toHaveLength(1);
    const cmd = commands[0];
    expect(cmd).toBeDefined();
    if (!cmd) {
      throw new Error("missing command");
    }

    expect(cmd.input).toEqual({
      FromEmailAddress: from,
      Destination: {
        ToAddresses: [to],
      },
      ConfigurationSetName: configurationSet,
      Content: {
        Simple: {
          Subject: {
            Data: expect.any(String),
          },
          Body: {
            Text: {
              Data: expect.any(String),
            },
          },
        },
      },
    });

    const simple = cmd.input.Content?.Simple;
    expect(simple).toBeDefined();
    if (!simple?.Subject?.Data || !simple.Body?.Text?.Data) {
      throw new Error("missing simple content");
    }

    const subject = simple.Subject.Data;
    expect(subject).not.toContain(code);

    const body = simple.Body.Text.Data;
    expect(body).toContain(code);
    expect(body).toMatch(/10\s*minutes/i);
    expect(body).toMatch(/ignore/i);
    expect(body).not.toMatch(/https?:\/\//i);

    expect(simple).not.toHaveProperty("Html");
    expect(Object.keys(simple)).toEqual(["Subject", "Body"]);
    if (!simple.Body) {
      throw new Error("missing body");
    }
    expect(Object.keys(simple.Body)).toEqual(["Text"]);

    expect(infoCalls).toEqual([{ operation: "send_email", outcome: "ok" }]);
  });

  it("maps SDK rejection to OtpMailUnavailable with failed outcome and error class name", async () => {
    class MessageRejected extends Error {
      constructor() {
        super("Email address is not verified.");
        this.name = "MessageRejected";
      }
    }

    const infoCalls: SesInfoFields[] = [];
    const client: SesClientLike = {
      send: vi.fn(async () => {
        throw new MessageRejected();
      }),
    };

    const mail = createSesOtpMail({
      client: () => client,
      from,
      configurationSet,
      info: (fields) => infoCalls.push(fields),
    });

    await expect(mail.send({ to, code })).rejects.toBeInstanceOf(OtpMailUnavailable);
    expect(infoCalls).toEqual([
      { operation: "send_email", outcome: "failed", errorClass: "MessageRejected" },
    ]);
  });

  it("maps non-Error throw to OtpMailUnavailable with failed outcome and no errorClass", async () => {
    const infoCalls: SesInfoFields[] = [];
    const client: SesClientLike = {
      send: vi.fn(async () => {
        throw "something broke";
      }),
    };

    const mail = createSesOtpMail({
      client: () => client,
      from,
      configurationSet,
      info: (fields) => infoCalls.push(fields),
    });

    await expect(mail.send({ to, code })).rejects.toBeInstanceOf(OtpMailUnavailable);
    expect(infoCalls).toEqual([{ operation: "send_email", outcome: "failed" }]);
  });

  it("maps client factory Error and non-Error throw to OtpMailUnavailable with failed outcome", async () => {
    const infoCalls: SesInfoFields[] = [];
    const mailError = createSesOtpMail({
      client: () => {
        throw new Error("credential failure");
      },
      from,
      configurationSet,
      info: (fields) => infoCalls.push(fields),
    });

    await expect(mailError.send({ to, code })).rejects.toBeInstanceOf(OtpMailUnavailable);
    expect(infoCalls).toEqual([
      { operation: "send_email", outcome: "failed", errorClass: "Error" },
    ]);

    infoCalls.length = 0;
    const mailNonError = createSesOtpMail({
      client: () => {
        throw "non-error factory failure";
      },
      from,
      configurationSet,
      info: (fields) => infoCalls.push(fields),
    });

    await expect(mailNonError.send({ to, code })).rejects.toBeInstanceOf(OtpMailUnavailable);
    expect(infoCalls).toEqual([{ operation: "send_email", outcome: "failed" }]);
  });

  it("aborts the signal and throws OtpMailUnavailable with timeout when client ignores signal and never resolves", async () => {
    vi.useFakeTimers();

    let capturedSignal: AbortSignal | undefined;
    const infoCalls: SesInfoFields[] = [];
    const client: SesClientLike = {
      send: vi.fn((_command, options) => {
        capturedSignal = options?.abortSignal;
        return new Promise(() => {});
      }),
    };

    const mail = createSesOtpMail({
      client: () => client,
      from,
      configurationSet,
      deadlineMs: 5000,
      info: (fields) => infoCalls.push(fields),
    });

    const sendPromise = mail.send({ to, code });
    sendPromise.catch(() => {});

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);

    await expect(sendPromise).rejects.toBeInstanceOf(OtpMailUnavailable);
    expect(capturedSignal?.aborted).toBe(true);
    expect(infoCalls).toEqual([{ operation: "send_email", outcome: "timeout" }]);
  });

  it("never logs the recipient address, code, SDK message or message id in info payloads", async () => {
    const infoCalls: SesInfoFields[] = [];
    const sensitiveMessage = "sensitive SDK error message details";
    const sensitiveMessageId = "msg-super-secret-id-999";

    class DetailedError extends Error {
      constructor() {
        super(sensitiveMessage);
        this.name = "DetailedError";
      }
    }

    let fail = false;
    const client: SesClientLike = {
      send: vi.fn(async () => {
        if (fail) {
          throw new DetailedError();
        }
        return { MessageId: sensitiveMessageId };
      }),
    };

    const mail = createSesOtpMail({
      client: () => client,
      from,
      configurationSet,
      info: (fields) => infoCalls.push(fields),
    });

    await mail.send({ to, code });
    fail = true;
    await expect(mail.send({ to, code })).rejects.toBeInstanceOf(OtpMailUnavailable);

    for (const call of infoCalls) {
      const serialised = JSON.stringify(call);
      expect(serialised).not.toContain(to);
      expect(serialised).not.toContain(code);
      expect(serialised).not.toContain(sensitiveMessage);
      expect(serialised).not.toContain(sensitiveMessageId);
    }
  });
});
