import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  IdentityError,
  SecondFactorNoticeUnavailable,
  rejectingSecondFactorNotice,
  type SecondFactorNoticeKind,
} from "@community-hub/identity";
import {
  createSesSecondFactorNotice,
  type SesClientLike,
  type SesInfoFields,
} from "./ses-second-factor-notice.js";

describe("createSesSecondFactorNotice", () => {
  const from = "no-reply@mail.example.test";
  const configurationSet = "community-hub-notices";
  const to = "user@example.test";
  const fixedNow = new Date("2026-11-26T01:23:45.000Z");

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds command input per kind with fixed subject, UTC time, owner warning, text-only body, and logs ok", async () => {
    const kinds: SecondFactorNoticeKind[] = [
      "totp_set_up",
      "totp_removed",
      "passkey_added",
      "passkey_removed",
      "backup_codes_made",
    ];
    const commands: SendEmailCommand[] = [];
    const infoCalls: SesInfoFields[] = [];
    const client: SesClientLike = {
      send: vi.fn(async (command) => {
        commands.push(command);
        return { MessageId: "msg-notice-123" };
      }),
    };

    const notice = createSesSecondFactorNotice({
      client: () => client,
      from,
      configurationSet,
      now: () => fixedNow,
      info: (fields) => infoCalls.push(fields),
    });

    for (const kind of kinds) {
      await notice.send({ to, kind });
    }

    expect(commands).toHaveLength(kinds.length);
    const bodies = new Set<string>();
    for (const cmd of commands) {
      expect(cmd.input).toEqual({
        FromEmailAddress: from,
        Destination: {
          ToAddresses: [to],
        },
        ConfigurationSetName: configurationSet,
        Content: {
          Simple: {
            Subject: {
              Data: "Your Community Hub sign-in methods changed",
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
      if (!simple?.Subject?.Data || !simple.Body?.Text?.Data) {
        throw new Error("missing simple content");
      }
      const body = simple.Body.Text.Data;
      expect(body).toContain(fixedNow.toISOString());
      expect(body).toContain("If this wasn't you, contact your organisation's owner.");
      expect(body).not.toContain(to);
      expect(body).not.toMatch(/otpauth:/i);
      expect(body).not.toMatch(/https?:\/\//i);
      expect(simple).not.toHaveProperty("Html");
      expect(Object.keys(simple)).toEqual(["Subject", "Body"]);
      expect(Object.keys(simple.Body)).toEqual(["Text"]);
      bodies.add(body);
    }

    expect(bodies.size).toBe(kinds.length);
    expect(infoCalls).toEqual(kinds.map(() => ({ operation: "send_email", outcome: "ok" })));
  });

  it("maps SDK rejection to SecondFactorNoticeUnavailable (IdentityError) with failed outcome and errorClass", async () => {
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

    const notice = createSesSecondFactorNotice({
      client: () => client,
      from,
      configurationSet,
      info: (fields) => infoCalls.push(fields),
    });

    const err = await notice.send({ to, kind: "totp_set_up" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecondFactorNoticeUnavailable);
    expect(err).toBeInstanceOf(IdentityError);
    expect(infoCalls).toEqual([
      { operation: "send_email", outcome: "failed", errorClass: "MessageRejected" },
    ]);
  });

  it("maps non-Error throw to SecondFactorNoticeUnavailable with failed outcome and no errorClass", async () => {
    const infoCalls: SesInfoFields[] = [];
    const client: SesClientLike = {
      send: vi.fn(async () => {
        throw "something broke";
      }),
    };

    const notice = createSesSecondFactorNotice({
      client: () => client,
      from,
      configurationSet,
      info: (fields) => infoCalls.push(fields),
    });

    await expect(notice.send({ to, kind: "totp_removed" })).rejects.toBeInstanceOf(
      SecondFactorNoticeUnavailable,
    );
    expect(infoCalls).toEqual([{ operation: "send_email", outcome: "failed" }]);
  });

  it("maps client factory Error and non-Error throw to SecondFactorNoticeUnavailable with failed outcome", async () => {
    const infoCalls: SesInfoFields[] = [];
    const noticeError = createSesSecondFactorNotice({
      client: () => {
        throw new Error("credential failure");
      },
      from,
      configurationSet,
      info: (fields) => infoCalls.push(fields),
    });

    await expect(noticeError.send({ to, kind: "passkey_added" })).rejects.toBeInstanceOf(
      SecondFactorNoticeUnavailable,
    );
    expect(infoCalls).toEqual([
      { operation: "send_email", outcome: "failed", errorClass: "Error" },
    ]);

    infoCalls.length = 0;
    const noticeNonError = createSesSecondFactorNotice({
      client: () => {
        throw "non-error factory failure";
      },
      from,
      configurationSet,
      info: (fields) => infoCalls.push(fields),
    });

    await expect(noticeNonError.send({ to, kind: "passkey_removed" })).rejects.toBeInstanceOf(
      SecondFactorNoticeUnavailable,
    );
    expect(infoCalls).toEqual([{ operation: "send_email", outcome: "failed" }]);
  });

  it("aborts the signal and throws SecondFactorNoticeUnavailable with timeout when client ignores signal", async () => {
    vi.useFakeTimers();

    let capturedSignal: AbortSignal | undefined;
    const infoCalls: SesInfoFields[] = [];
    const client: SesClientLike = {
      send: vi.fn((_command, options) => {
        capturedSignal = options?.abortSignal;
        return new Promise(() => {});
      }),
    };

    const notice = createSesSecondFactorNotice({
      client: () => client,
      from,
      configurationSet,
      deadlineMs: 5000,
      info: (fields) => infoCalls.push(fields),
    });

    const sendPromise = notice.send({ to, kind: "backup_codes_made" });
    sendPromise.catch(() => {});

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);

    await expect(sendPromise).rejects.toBeInstanceOf(SecondFactorNoticeUnavailable);
    expect(capturedSignal?.aborted).toBe(true);
    expect(infoCalls).toEqual([{ operation: "send_email", outcome: "timeout" }]);
  });

  it("never logs the recipient address, SDK message or message id in info payloads", async () => {
    const infoCalls: SesInfoFields[] = [];
    const sensitiveMessage = `sensitive SDK error for ${to}`;
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

    const notice = createSesSecondFactorNotice({
      client: () => client,
      from,
      configurationSet,
      info: (fields) => infoCalls.push(fields),
    });

    await notice.send({ to, kind: "totp_set_up" });
    fail = true;
    await expect(notice.send({ to, kind: "totp_removed" })).rejects.toBeInstanceOf(
      SecondFactorNoticeUnavailable,
    );

    for (const call of infoCalls) {
      const serialised = JSON.stringify(call);
      expect(serialised).not.toContain(to);
      expect(serialised).not.toContain(sensitiveMessage);
      expect(serialised).not.toContain(sensitiveMessageId);
    }
  });

  it("rejectingSecondFactorNotice rejects with an IdentityError", async () => {
    await expect(
      rejectingSecondFactorNotice.send({ to, kind: "totp_set_up" }),
    ).rejects.toMatchObject({
      code: "email_unavailable",
    });
    const err = await rejectingSecondFactorNotice
      .send({ to, kind: "totp_set_up" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityError);
  });
});
