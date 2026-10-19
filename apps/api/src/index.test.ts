import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@community-hub/observability";
import { OtpMailUnavailable } from "@community-hub/identity";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { BillingUnavailable } from "@community-hub/billing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readServiceEnv } from "./env.js";
import { bindServices, boot, listeningServer, productionRoutes, run } from "./index.js";
import * as serverModule from "./server.js";
import { rejectingStripeBilling } from "./billing/stripe-adapter.js";

const pem = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../certs/rds-ap-southeast-2-bundle.pem"),
  "utf8",
);

const marker = "arn:aws:kms:ap-southeast-2:123456789012:alias/not-a-key";

function source(): NodeJS.ProcessEnv {
  return {
    PORT: "18453",
    PGPORT: "5432",
    AWS_REGION: "ap-southeast-2",
    NODE_ENV: "test",
    COMMUNITY_HUB_ENVIRONMENT: "staging",
    API_HOSTNAME: "au.api.example.test",
    AUTH_HOSTNAME: "auth.au.example.test",
    WEBHOOKS_HOSTNAME: "webhooks.au.example.test",
    OPS_HOSTNAME: "ops.au.example.test",
    PGHOST: "db.internal",
    PGDATABASE: "communityhub",
    PGUSER_APP: "app",
    PGUSER_IDENTITY: "identity",
    PGUSER_PLATFORM: "platform",
    PGPASSWORD_APP: "pw-app",
    PGPASSWORD_IDENTITY: "pw-identity",
    PGPASSWORD_PLATFORM: "pw-platform",
    ENVELOPE_KEY_ARN: marker,
    APP_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:app",
    IDENTITY_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity",
    PLATFORM_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:platform",
  };
}

describe("api entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listeningServer()?.closeAllConnections();
    listeningServer()?.close();
  });

  it("does not listen when the module is imported", () => {
    expect(listeningServer()).toBeUndefined();
  });

  it("writes env and does not listen when the envelope key is an alias", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    const code = run(source(), pem, [
      {
        method: "GET",
        pattern: "/health",
        surface: "all",
        billing: "exempt",
        handle: () => Response.json({ ok: true }),
      },
    ]);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["env\n"]);
    expect(stderr.join("")).not.toContain(marker);
    expect(listeningServer()).toBeUndefined();
  });

  it("writes routes when the table is rejected", () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const env = source();
    env.ENVELOPE_KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;

    const code = run(env, pem, [
      {
        method: "GET",
        pattern: "/other",
        surface: "all",
        billing: "exempt",
        handle: () => new Response(null, { status: 204 }),
      },
    ]);

    expect(code).toBe(1);
    expect(stderr).toEqual(["routes\n"]);
    expect(stderr.join("")).not.toContain("/other");
    expect(listeningServer()).toBeUndefined();
  });

  it("prints env and exits 1 when the certificate file is missing", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    let code: number | undefined;
    boot({
      readPem: () => {
        throw new Error("marker-missing-cert");
      },
      source: source(),
      routes: [
        {
          method: "GET",
          pattern: "/health",
          surface: "all",
          billing: "exempt",
          handle: () => Response.json({ ok: true }),
        },
      ],
      exit: (value) => {
        code = value;
      },
    });
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["env\n"]);
    expect(stderr.join("")).not.toContain("marker-missing-cert");
    expect(listeningServer()).toBeUndefined();
  });
});

describe("api boot wiring of the kms adapter log", () => {
  const keyArn = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
  const otherKeyId = "marker-not-the-configured-key-9d41";
  const context = { key_kind: "identity", region: "au", key_version: "1" } as const;

  function env() {
    const read = readServiceEnv({ ...source(), ENVELOPE_KEY_ARN: keyArn }, pem);
    if (!read.ok) {
      throw new Error("test env is invalid");
    }
    return read.env;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a kms line with only allow-listed fields when the adapter reports a failure", async () => {
    const written: string[] = [];
    const logger = createLogger({ write: (line) => written.push(line) });
    const bound = bindServices(env(), pem, logger);

    await expect(
      bound.auth.kms.decrypt(otherKeyId, new Uint8Array([1, 2, 3]), context),
    ).rejects.toThrow();

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "{}")).toEqual({
      level: "info",
      message: "kms",
      operation: "decrypt",
      key_kind: "identity",
      outcome: "rejected",
    });
    expect(written[0]).not.toContain(otherKeyId);
    expect(written[0]).not.toContain(keyArn);
    expect(written[0]).not.toContain("123456789012");
    expect(logger.getDroppedFieldCount()).toBe(0);
  });

  it("shares one adapter between the auth and access routes", async () => {
    const written: string[] = [];
    const bound = bindServices(env(), pem, createLogger({ write: (line) => written.push(line) }));

    await expect(bound.access.kms.generateDataKey(otherKeyId, context)).rejects.toThrow();

    expect(bound.access.kms).toBe(bound.auth.kms);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "{}")).toMatchObject({
      message: "kms",
      operation: "generate_data_key",
      outcome: "rejected",
    });
  });

  it("uses a real logger when none is passed", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const bound = bindServices(env(), pem);

    await expect(
      bound.auth.kms.decrypt(otherKeyId, new Uint8Array([1]), context),
    ).rejects.toThrow();

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ message: "kms", outcome: "rejected" });
  });
});

const { sesInstances, FakeSESv2Client } = vi.hoisted(() => {
  const instances: Array<{
    options: unknown;
    send: ReturnType<typeof vi.fn>;
  }> = [];

  class FakeSESv2Client {
    public options: unknown;
    public static sendImpl: ((cmd: unknown) => Promise<unknown>) | undefined;
    public send = vi.fn(async (cmd: unknown) => {
      if (FakeSESv2Client.sendImpl) {
        return FakeSESv2Client.sendImpl(cmd);
      }
      return { MessageId: "msg-12345" };
    });

    constructor(options?: unknown) {
      this.options = options;
      instances.push(this);
    }
  }

  return { sesInstances: instances, FakeSESv2Client };
});

vi.mock("@aws-sdk/client-sesv2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-sesv2")>();
  return {
    ...actual,
    SESv2Client: FakeSESv2Client,
  };
});

describe("api boot wiring of the ses mail adapter", () => {
  const keyArn = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;

  function envWithMail() {
    const read = readServiceEnv(
      {
        ...source(),
        ENVELOPE_KEY_ARN: keyArn,
        MAIL_FROM_ADDRESS: "no-reply@mail.example.test",
        SES_CONFIGURATION_SET: "community-hub-otp",
      },
      pem,
    );
    if (!read.ok) {
      throw new Error("test env is invalid");
    }
    return read.env;
  }

  function envWithoutMail() {
    const read = readServiceEnv({ ...source(), ENVELOPE_KEY_ARN: keyArn }, pem);
    if (!read.ok) {
      throw new Error("test env is invalid");
    }
    return read.env;
  }

  beforeEach(() => {
    FakeSESv2Client.sendImpl = undefined;
    sesInstances.length = 0;
  });

  afterEach(() => {
    FakeSESv2Client.sendImpl = undefined;
    vi.restoreAllMocks();
  });

  it("with both variables, auth.mail.send calls spy send once, constructor receives exact options, and logger outputs ok with 0 dropped fields", async () => {
    const written: string[] = [];
    const logger = createLogger({ write: (line) => written.push(line) });
    const e = envWithMail();
    const bound = bindServices(e, pem, logger);

    await bound.auth.mail.send({ to: "user@example.test", code: "12345678" });

    expect(sesInstances).toHaveLength(1);
    const instance = sesInstances[0]!;
    expect(instance.options).toEqual({ region: e.AWS_REGION, maxAttempts: 1 });
    expect(instance.send).toHaveBeenCalledTimes(1);

    expect(written).toHaveLength(1);
    const line = JSON.parse(written[0] ?? "{}") as Record<string, unknown>;
    expect(line).toEqual({
      level: "info",
      message: "mail",
      operation: "send_email",
      outcome: "ok",
    });
    expect(logger.getDroppedFieldCount()).toBe(0);
  });

  it("with a failing spy send, logger outputs failed outcome and errorClass with 0 dropped fields", async () => {
    class MessageRejected extends Error {
      constructor() {
        super("Message rejected");
        this.name = "MessageRejected";
      }
    }

    FakeSESv2Client.sendImpl = async () => {
      throw new MessageRejected();
    };

    const written: string[] = [];
    const logger = createLogger({ write: (line) => written.push(line) });
    const bound = bindServices(envWithMail(), pem, logger);

    await expect(
      bound.auth.mail.send({ to: "user@example.test", code: "12345678" }),
    ).rejects.toBeInstanceOf(OtpMailUnavailable);

    expect(written).toHaveLength(1);
    const line = JSON.parse(written[0] ?? "{}") as Record<string, unknown>;
    expect(line).toEqual({
      level: "info",
      message: "mail",
      operation: "send_email",
      outcome: "failed",
      errorClass: "MessageRejected",
    });
    expect(logger.getDroppedFieldCount()).toBe(0);
  });

  it("without the variables, auth.mail.send rejects with OtpMailUnavailable and spy constructor was never called", async () => {
    const bound = bindServices(envWithoutMail(), pem);

    await expect(
      bound.auth.mail.send({ to: "user@example.test", code: "12345678" }),
    ).rejects.toBeInstanceOf(OtpMailUnavailable);

    expect(sesInstances).toHaveLength(0);
  });
});

describe("api boot wiring of the billing adapter and logger", () => {
  const keyArn = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
  const billingSecretArn =
    "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:staging-billing-123456";
  const adminOrigin = "https://admin.example.test";

  function envWithBilling() {
    const read = readServiceEnv(
      {
        ...source(),
        ENVELOPE_KEY_ARN: keyArn,
        BILLING_SECRET_ARN: billingSecretArn,
        ADMIN_ORIGIN: adminOrigin,
      },
      pem,
    );
    if (!read.ok) {
      throw new Error("test env is invalid");
    }
    return read.env;
  }

  function envWithoutBilling() {
    const read = readServiceEnv({ ...source(), ENVELOPE_KEY_ARN: keyArn }, pem);
    if (!read.ok) {
      throw new Error("test env is invalid");
    }
    return read.env;
  }

  it("boot with neither billing variable succeeds and the port rejects with BILLING_KEY_UNAVAILABLE", async () => {
    const bound = bindServices(envWithoutBilling(), pem);
    await expect(bound.billing.port.retrieveSubscription("sub_test1")).rejects.toThrow(
      new BillingUnavailable("BILLING_KEY_UNAVAILABLE"),
    );
  });

  it("boot with both billing variables wires the real adapter and lazily calls secrets manager (M3)", async () => {
    const sendSpy = vi
      .spyOn(SecretsManagerClient.prototype, "send")
      .mockImplementation(async () => {
        return {
          SecretString: JSON.stringify({
            // live key in staging triggers BILLING_KEY_MODE_MISMATCH on get(), verifying laziness without Stripe network calls
            secret_key: "sk_live_synthetic_for_m3",
            webhook_secret: "whsec_synthetic_for_m3",
          }),
        } as never;
      });
    try {
      const bound = bindServices(envWithBilling(), pem);
      expect(bound.billing).toBeDefined();
      expect(bound.billing.port).not.toBe(rejectingStripeBilling);
      expect(sendSpy).not.toHaveBeenCalled();

      // First port method call invokes SecretsManagerClient.prototype.send
      await expect(bound.billing.port.retrieveSubscription("sub_test1")).rejects.toThrow(
        new BillingUnavailable("BILLING_KEY_MODE_MISMATCH"),
      );
      expect(sendSpy).toHaveBeenCalledTimes(1);
    } finally {
      sendSpy.mockRestore();
    }
  });

  it("writes adapter stripe_call lines through the real logger with 0 dropped fields (L1)", async () => {
    const sendSpy = vi
      .spyOn(SecretsManagerClient.prototype, "send")
      .mockImplementation(async () => {
        return {
          SecretString: JSON.stringify({
            // live key in staging triggers BILLING_KEY_MODE_MISMATCH
            secret_key: "sk_live_synthetic_for_l1",
            webhook_secret: "whsec_synthetic_for_l1",
          }),
        } as never;
      });
    try {
      const written: string[] = [];
      const logger = createLogger({ write: (line) => written.push(line) });
      const bound = bindServices(envWithBilling(), pem, logger);

      await expect(bound.billing.port.retrieveSubscription("sub_test1")).rejects.toThrow(
        new BillingUnavailable("BILLING_KEY_MODE_MISMATCH"),
      );

      expect(written).toHaveLength(1);
      const logLine = JSON.parse(written[0] ?? "{}") as Record<string, unknown>;
      expect(logLine).toEqual({
        level: "info",
        message: "stripe",
        operation: "stripe_call",
        outcome: "failed",
        errorCode: "BILLING_KEY_MODE_MISMATCH",
      });
      expect(logger.getDroppedFieldCount()).toBe(0);
    } finally {
      sendSpy.mockRestore();
    }
  });

  it("a billing log line through the real logger parses with getDroppedFieldCount() === 0", () => {
    const written: string[] = [];
    const logger = createLogger({ write: (line) => written.push(line) });
    const bound = bindServices(envWithBilling(), pem, logger);

    bound.billing.log("billing test line", {
      operation: "stripe_call",
      outcome: "ok",
      organisationId: "12345678-1234-4234-8234-1234567890ab",
    });

    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0] ?? "{}") as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: "info",
      message: "billing test line",
      operation: "stripe_call",
      outcome: "ok",
      organisationId: "12345678-1234-4234-8234-1234567890ab",
    });
    expect(logger.getDroppedFieldCount()).toBe(0);
  });

  it("productionRoutes includes POST /v1/stripe/webhook with largeBody webhooks", () => {
    const routes = productionRoutes(envWithBilling(), pem);
    const webhookRoute = routes.find(
      (r) => r.method === "POST" && r.pattern === "/v1/stripe/webhook",
    );
    expect(webhookRoute).toBeDefined();
    expect(webhookRoute?.surface).toBe("tenant");
    expect(webhookRoute?.largeBody).toBe("webhooks");
  });

  it("registers the three billing routes and the webhook route in productionRoutes and run", () => {
    const startServerSpy = vi.spyOn(serverModule, "startServer").mockReturnValue({} as never);
    try {
      const routes = productionRoutes(envWithBilling(), pem);
      const expectedBillingRoutes = [
        { method: "POST", pattern: "/v1/billing/checkout", surface: "tenant" },
        { method: "POST", pattern: "/v1/billing/portal", surface: "tenant" },
        { method: "POST", pattern: "/v1/billing/status", surface: "tenant" },
        { method: "POST", pattern: "/v1/stripe/webhook", surface: "tenant", largeBody: "webhooks" },
      ];

      for (const expected of expectedBillingRoutes) {
        const found = routes.find(
          (r) => r.method === expected.method && r.pattern === expected.pattern,
        );
        expect(found).toBeDefined();
        expect(found?.surface).toBe(expected.surface);
        if (expected.largeBody) {
          expect(found?.largeBody).toBe(expected.largeBody);
        }
      }

      const envSource = {
        ...source(),
        ENVELOPE_KEY_ARN: keyArn,
        BILLING_SECRET_ARN: billingSecretArn,
        ADMIN_ORIGIN: adminOrigin,
      };
      const runResult = run(envSource, pem, []);
      expect(runResult).toBe(0);
      expect(startServerSpy).toHaveBeenCalledTimes(1);
      const passedRoutes = startServerSpy.mock.calls[0]?.[0]?.routes ?? [];

      for (const expected of expectedBillingRoutes) {
        const found = passedRoutes.find(
          (r) => r.method === expected.method && r.pattern === expected.pattern,
        );
        expect(found).toBeDefined();
        expect(found?.surface).toBe(expected.surface);
        if (expected.largeBody) {
          expect(found?.largeBody).toBe(expected.largeBody);
        }
      }
    } finally {
      startServerSpy.mockRestore();
    }
  });

  it("marks every production route as exempt, read, or write matching the spec exactly", () => {
    const routes = productionRoutes(envWithBilling(), pem);
    const markings = new Map(
      routes.map((route) => [
        `${route.method} ${route.pattern}`,
        (route as { billing?: string }).billing,
      ]),
    );
    expect(routes).toHaveLength(21);
    expect(markings).toEqual(
      new Map([
        ["GET /health", "exempt"],
        ["POST /v1/auth/email-otp/start", "exempt"],
        ["POST /v1/auth/email-otp/verify", "exempt"],
        ["POST /v1/auth/passkey/register/options", "exempt"],
        ["POST /v1/auth/passkey/register/verify", "exempt"],
        ["POST /v1/auth/passkey/authenticate/options", "exempt"],
        ["POST /v1/auth/passkey/authenticate/verify", "exempt"],
        ["POST /v1/auth/session/refresh", "exempt"],
        ["POST /v1/billing/checkout", "exempt"],
        ["POST /v1/billing/portal", "exempt"],
        ["POST /v1/billing/status", "exempt"],
        ["POST /v1/stripe/webhook", "exempt"],
        ["POST /v1/access/grants/list", "read"],
        ["POST /v1/entitlements/list", "read"],
        ["POST /v1/access/grants", "write"],
        ["POST /v1/access/grants/revoke", "write"],
        ["POST /v1/access/custom-roles", "write"],
        ["POST /v1/access/custom-roles/delete", "write"],
        ["POST /v1/access/user-links", "write"],
        ["POST /v1/access/user-links/delete", "write"],
        ["POST /v1/entitlements/toggle", "write"],
      ]),
    );
  });
});
