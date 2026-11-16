import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { InvitationMailUnavailable } from "@community-hub/access";
import {
  createSesInvitationMail,
  type SesClientLike,
  type SesInfoFields,
} from "./ses-invitation-mail.js";

describe("createSesInvitationMail", () => {
  const from = "no-reply@mail.example.test";
  const configurationSet = "community-hub-invitations";
  const to = "invitee@example.test";
  const communitySlug = "st-marys";
  const link = "https://admin.example.test/#invite=v1.sample-token";
  const expiresAt = new Date("2026-11-22T00:00:00.000Z");

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds command input field by field, subject has community slug, body has link and deadline, and logs ok", async () => {
    const commands: SendEmailCommand[] = [];
    const infoCalls: SesInfoFields[] = [];
    const client: SesClientLike = {
      send: vi.fn(async (command) => {
        commands.push(command);
        return { MessageId: "msg-inv-12345" };
      }),
    };

    const mail = createSesInvitationMail({
      client: () => client,
      from,
      configurationSet,
      info: (fields) => infoCalls.push(fields),
    });

    await mail.send({ to, communitySlug, link, expiresAt });

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
            Data: `You're invited to ${communitySlug} on Community Hub`,
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
    expect(subject).toBe(`You're invited to ${communitySlug} on Community Hub`);

    const body = simple.Body.Text.Data;
    expect(body).toContain(communitySlug);
    expect(body).toContain(expiresAt.toISOString());
    expect(body).toContain(link);
    expect(body).toContain("If you weren't expecting this, you can ignore it");
    expect(body).not.toContain("invited by");

    expect(simple).not.toHaveProperty("Html");
    expect(Object.keys(simple)).toEqual(["Subject", "Body"]);
    if (!simple.Body) {
      throw new Error("missing body");
    }
    expect(Object.keys(simple.Body)).toEqual(["Text"]);

    expect(infoCalls).toEqual([{ operation: "send_email", outcome: "ok" }]);
  });

  it("aborts the signal and throws InvitationMailUnavailable with timeout when client ignores signal and never resolves, logging nothing on failure", async () => {
    vi.useFakeTimers();

    let capturedSignal: AbortSignal | undefined;
    const infoCalls: SesInfoFields[] = [];
    const client: SesClientLike = {
      send: vi.fn((_command, options) => {
        capturedSignal = options?.abortSignal;
        return new Promise(() => {});
      }),
    };

    const mail = createSesInvitationMail({
      client: () => client,
      from,
      configurationSet,
      deadlineMs: 5000,
      info: (fields) => infoCalls.push(fields),
    });

    const sendPromise = mail.send({ to, communitySlug, link, expiresAt });
    sendPromise.catch(() => {});

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);

    await expect(sendPromise).rejects.toBeInstanceOf(InvitationMailUnavailable);
    expect(capturedSignal?.aborted).toBe(true);
    expect(infoCalls).toEqual([]);
  });

  it("maps SDK failure to InvitationMailUnavailable and logs nothing on failure", async () => {
    const infoCalls: SesInfoFields[] = [];
    const client: SesClientLike = {
      send: vi.fn(async () => {
        throw new Error("SES internal error");
      }),
    };

    const mail = createSesInvitationMail({
      client: () => client,
      from,
      configurationSet,
      info: (fields) => infoCalls.push(fields),
    });

    await expect(mail.send({ to, communitySlug, link, expiresAt })).rejects.toBeInstanceOf(
      InvitationMailUnavailable,
    );
    expect(infoCalls).toEqual([]);
  });

  it("pin 42 (ses): an SES error carrying the address is never logged", async () => {
    const infoCalls: SesInfoFields[] = [];
    const sensitiveMessage = `SES rejected destination address ${to}`;
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    class DetailedError extends Error {
      constructor() {
        super(sensitiveMessage);
        this.name = "DetailedError";
      }
    }

    const client: SesClientLike = {
      send: vi.fn(async () => {
        throw new DetailedError();
      }),
    };

    const mail = createSesInvitationMail({
      client: () => client,
      from,
      configurationSet,
      info: (fields) => infoCalls.push(fields),
    });

    try {
      await expect(mail.send({ to, communitySlug, link, expiresAt })).rejects.toBeInstanceOf(
        InvitationMailUnavailable,
      );

      expect(infoCalls).toHaveLength(0);
      const serialized = JSON.stringify(infoCalls);
      expect(serialized).not.toContain(to);
      expect(serialized).not.toContain(sensitiveMessage);
      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleInfo).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
      consoleInfo.mockRestore();
      consoleWarn.mockRestore();
      consoleError.mockRestore();
    }
  });
});
