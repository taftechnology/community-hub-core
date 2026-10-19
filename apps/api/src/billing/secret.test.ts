import util from "node:util";
import { describe, expect, it, vi } from "vitest";

import { BillingUnavailable } from "@community-hub/billing";
import { billingSecret } from "./secret.js";

const SYNTHETIC_ARN =
  "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-billing-Ab12Cd";

describe("billingSecret", () => {
  it("reads lazily and caches the parsed secret across uses, refreshing after invalidate()", async () => {
    const reader = vi.fn(async () =>
      JSON.stringify({
        secret_key: "sk_test_synthetic123",
        webhook_secret: "whsec_synthetic123",
      }),
    );

    const secret = billingSecret(reader, SYNTHETIC_ARN, "staging");
    expect(reader).not.toHaveBeenCalled();

    const first = await secret.get();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith(SYNTHETIC_ARN, "AWSCURRENT");
    expect(first.secretKey).toBe("sk_test_synthetic123");
    expect(first.webhookSecret).toBe("whsec_synthetic123");

    const second = await secret.get();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(second.secretKey).toBe("sk_test_synthetic123");
    expect(second.webhookSecret).toBe("whsec_synthetic123");

    secret.invalidate();

    const third = await secret.get();
    expect(reader).toHaveBeenCalledTimes(2);
    expect(third.secretKey).toBe("sk_test_synthetic123");
  });

  it("maps reader rejection to BILLING_KEY_UNAVAILABLE without leaking the ARN", async () => {
    const errorWithArn = new Error(`ResourceNotFoundException: secret ${SYNTHETIC_ARN} not found`);
    const reader = vi.fn(async () => {
      throw errorWithArn;
    });

    const secret = billingSecret(reader, SYNTHETIC_ARN, "staging");

    let thrown: unknown;
    try {
      await secret.get();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(BillingUnavailable);
    const billingError = thrown as BillingUnavailable;
    expect(billingError.code).toBe("BILLING_KEY_UNAVAILABLE");
    expect(billingError.message).toBe("BILLING_KEY_UNAVAILABLE");

    // The thrown error must not contain the synthetic ARN or reader error message
    const serialized = JSON.stringify(billingError);
    expect(serialized).not.toContain(SYNTHETIC_ARN);
    expect(serialized).not.toContain("123456789012");
    expect(serialized).not.toContain("ResourceNotFoundException");
    expect(String(billingError)).not.toContain(SYNTHETIC_ARN);
    expect(String(billingError)).not.toContain("123456789012");

    expect((billingError as Error).cause).toBeUndefined();
    expect(String(billingError.stack)).not.toContain("123456789012");
    expect(Object.getOwnPropertyNames(billingError).sort()).toEqual([
      "code",
      "message",
      "name",
      "stack",
    ]);
  });

  it("maps invalid JSON to BILLING_KEY_UNAVAILABLE", async () => {
    const reader = vi.fn(async () => `{"arn":"${SYNTHETIC_ARN}", invalid-json`);
    const secret = billingSecret(reader, SYNTHETIC_ARN, "staging");

    let thrown: unknown;
    try {
      await secret.get();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(BillingUnavailable);
    const billingError = thrown as BillingUnavailable;
    expect(billingError.code).toBe("BILLING_KEY_UNAVAILABLE");
    expect(billingError.message).toBe("BILLING_KEY_UNAVAILABLE");

    expect((billingError as Error).cause).toBeUndefined();
    expect(String(billingError.stack)).not.toContain("123456789012");
    expect(Object.getOwnPropertyNames(billingError).sort()).toEqual([
      "code",
      "message",
      "name",
      "stack",
    ]);
  });

  it.each([
    ["missing secret_key", { webhook_secret: "whsec_synthetic" }],
    ["missing webhook_secret", { secret_key: "sk_test_synthetic" }],
    ["null payload", null],
    ["array payload", []],
    ["number payload", 42],
    ["non-string secret_key", { secret_key: 1234, webhook_secret: "whsec_synthetic" }],
    ["empty secret_key", { secret_key: "", webhook_secret: "whsec_synthetic" }],
    [
      "webhook_secret lacking whsec_ prefix",
      { secret_key: "sk_test_synthetic", webhook_secret: "bad_prefix" },
    ],
    ["bare webhook_secret prefix", { secret_key: "sk_test_synthetic", webhook_secret: "whsec_" }],
  ])("maps invalid payload (%s) to BILLING_KEY_UNAVAILABLE", async (_label, payload) => {
    const reader = vi.fn(async () => JSON.stringify(payload));
    const secret = billingSecret(reader, SYNTHETIC_ARN, "staging");

    await expect(secret.get()).rejects.toThrow(BillingUnavailable);
    await expect(secret.get()).rejects.toMatchObject({
      code: "BILLING_KEY_UNAVAILABLE",
    });
  });

  it("rejects a live key in staging with BILLING_KEY_MODE_MISMATCH", async () => {
    const skLiveReader = vi.fn(async () =>
      JSON.stringify({
        secret_key: "sk_live_synthetic123",
        webhook_secret: "whsec_synthetic123",
      }),
    );
    const skSecret = billingSecret(skLiveReader, SYNTHETIC_ARN, "staging");
    await expect(skSecret.get()).rejects.toMatchObject({
      code: "BILLING_KEY_MODE_MISMATCH",
    });

    const rkLiveReader = vi.fn(async () =>
      JSON.stringify({
        secret_key: "rk_live_synthetic123",
        webhook_secret: "whsec_synthetic123",
      }),
    );
    const rkSecret = billingSecret(rkLiveReader, SYNTHETIC_ARN, "staging");
    await expect(rkSecret.get()).rejects.toMatchObject({
      code: "BILLING_KEY_MODE_MISMATCH",
    });
  });

  it("rejects a test key in prod with BILLING_KEY_MODE_MISMATCH", async () => {
    const skTestReader = vi.fn(async () =>
      JSON.stringify({
        secret_key: "sk_test_synthetic123",
        webhook_secret: "whsec_synthetic123",
      }),
    );
    const skSecret = billingSecret(skTestReader, SYNTHETIC_ARN, "prod");
    await expect(skSecret.get()).rejects.toMatchObject({
      code: "BILLING_KEY_MODE_MISMATCH",
    });

    const rkTestReader = vi.fn(async () =>
      JSON.stringify({
        secret_key: "rk_test_synthetic123",
        webhook_secret: "whsec_synthetic123",
      }),
    );
    const rkSecret = billingSecret(rkTestReader, SYNTHETIC_ARN, "prod");
    await expect(rkSecret.get()).rejects.toMatchObject({
      code: "BILLING_KEY_MODE_MISMATCH",
    });
  });

  it.each([
    ["bare sk_test_ in staging", "sk_test_", "staging"],
    ["bare rk_test_ in staging", "rk_test_", "staging"],
    ["bare sk_live_ in prod", "sk_live_", "prod"],
    ["bare rk_live_ in prod", "rk_live_", "prod"],
  ])("rejects bare key prefix (%s) with BILLING_KEY_MODE_MISMATCH", async (_label, key, env) => {
    const reader = vi.fn(async () =>
      JSON.stringify({
        secret_key: key,
        webhook_secret: "whsec_synthetic123",
      }),
    );
    const secret = billingSecret(reader, SYNTHETIC_ARN, env as "staging" | "prod");
    await expect(secret.get()).rejects.toMatchObject({
      code: "BILLING_KEY_MODE_MISMATCH",
    });
  });

  it("fails closed on unknown environment with BILLING_KEY_MODE_MISMATCH", async () => {
    const reader = vi.fn(async () =>
      JSON.stringify({
        secret_key: "sk_test_synthetic123",
        webhook_secret: "whsec_synthetic123",
      }),
    );
    const secret = billingSecret(reader, SYNTHETIC_ARN, "development" as unknown as "staging");
    await expect(secret.get()).rejects.toMatchObject({
      code: "BILLING_KEY_MODE_MISMATCH",
    });
  });

  it("redacts keys in JSON.stringify and util.inspect", async () => {
    const reader = vi.fn(async () =>
      JSON.stringify({
        secret_key: "sk_test_synthetic123",
        webhook_secret: "whsec_synthetic123",
      }),
    );
    const secret = billingSecret(reader, SYNTHETIC_ARN, "staging");
    const values = await secret.get();

    expect(values.secretKey).toBe("sk_test_synthetic123");
    expect(values.webhookSecret).toBe("whsec_synthetic123");

    const json = JSON.stringify(values);
    expect(json).not.toContain("sk_test_synthetic123");
    expect(json).not.toContain("whsec_synthetic123");

    const inspected = util.inspect(values);
    expect(inspected).not.toContain("sk_test_synthetic123");
    expect(inspected).not.toContain("whsec_synthetic123");
  });

  it("accepts valid sk_test_ and rk_test_ in staging, and sk_live_ and rk_live_ in prod", async () => {
    const stagingSk = billingSecret(
      async () =>
        JSON.stringify({
          secret_key: "sk_test_synthetic123",
          webhook_secret: "whsec_synthetic123",
        }),
      SYNTHETIC_ARN,
      "staging",
    );
    const stagingSkRes = await stagingSk.get();
    expect(stagingSkRes.secretKey).toBe("sk_test_synthetic123");

    const stagingRk = billingSecret(
      async () =>
        JSON.stringify({
          secret_key: "rk_test_synthetic123",
          webhook_secret: "whsec_synthetic123",
        }),
      SYNTHETIC_ARN,
      "staging",
    );
    const stagingRkRes = await stagingRk.get();
    expect(stagingRkRes.secretKey).toBe("rk_test_synthetic123");

    const prodSk = billingSecret(
      async () =>
        JSON.stringify({
          secret_key: "sk_live_synthetic123",
          webhook_secret: "whsec_synthetic123",
        }),
      SYNTHETIC_ARN,
      "prod",
    );
    const prodSkRes = await prodSk.get();
    expect(prodSkRes.secretKey).toBe("sk_live_synthetic123");

    const prodRk = billingSecret(
      async () =>
        JSON.stringify({
          secret_key: "rk_live_synthetic123",
          webhook_secret: "whsec_synthetic123",
        }),
      SYNTHETIC_ARN,
      "prod",
    );
    const prodRkRes = await prodRk.get();
    expect(prodRkRes.secretKey).toBe("rk_live_synthetic123");
  });

  it("resolves race between concurrent read and invalidate using generation counter", async () => {
    let resolveFirstRead!: (value: string) => void;
    const firstReadDeferred = new Promise<string>((resolve) => {
      resolveFirstRead = resolve;
    });

    const reader = vi
      .fn()
      .mockImplementationOnce(() => firstReadDeferred)
      .mockImplementationOnce(async () =>
        JSON.stringify({
          secret_key: "sk_test_synthetic_v2",
          webhook_secret: "whsec_synthetic_v2",
        }),
      );

    const secret = billingSecret(reader, SYNTHETIC_ARN, "staging");

    // Deferred first read starts (version 1)
    const firstReadPromise = secret.get();

    // Cache is invalidated while first read is still in-flight
    secret.invalidate();

    // Second read runs and returns v2
    const secondRead = await secret.get();
    expect(secondRead.secretKey).toBe("sk_test_synthetic_v2");
    expect(secondRead.webhookSecret).toBe("whsec_synthetic_v2");

    // Release the first read (version 1)
    resolveFirstRead(
      JSON.stringify({
        secret_key: "sk_test_synthetic_v1",
        webhook_secret: "whsec_synthetic_v1",
      }),
    );
    const firstRead = await firstReadPromise;
    expect(firstRead.secretKey).toBe("sk_test_synthetic_v1");

    // Subsequent get() must return v2, not overwritten by stale v1
    const thirdRead = await secret.get();
    expect(thirdRead.secretKey).toBe("sk_test_synthetic_v2");
    expect(reader).toHaveBeenCalledTimes(2);
  });
});
