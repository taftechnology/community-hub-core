import util from "node:util";

import { BillingUnavailable } from "@community-hub/billing";

export type BillingSecretReader = (
  arn: string,
  stage?: "AWSCURRENT" | "AWSPREVIOUS",
) => Promise<string>;

export type BillingSecretValues = {
  readonly secretKey: string;
  readonly webhookSecret: string;
};

export type BillingSecret = {
  get(): Promise<BillingSecretValues>;
  invalidate(): void;
};

export function billingSecret(
  readSecret: BillingSecretReader,
  arn: string,
  environment: "staging" | "prod",
): BillingSecret {
  let generation = 0;
  let cached: BillingSecretValues | undefined;
  let inflight: Promise<BillingSecretValues> | undefined;

  async function get(): Promise<BillingSecretValues> {
    if (cached !== undefined) {
      return cached;
    }
    if (inflight !== undefined) {
      return inflight;
    }

    const currentGeneration = generation;
    const promise = (async () => {
      let raw: string;
      try {
        raw = await readSecret(arn, "AWSCURRENT");
      } catch {
        throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
      }

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        !("secret_key" in parsed) ||
        !("webhook_secret" in parsed)
      ) {
        throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
      }

      const rec = parsed as Record<string, unknown>;
      if (
        typeof rec.secret_key !== "string" ||
        typeof rec.webhook_secret !== "string" ||
        rec.secret_key.length === 0 ||
        rec.webhook_secret.length === 0
      ) {
        throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
      }

      const secret_key = rec.secret_key;
      const webhook_secret = rec.webhook_secret;

      if (!webhook_secret.startsWith("whsec_") || webhook_secret.length <= "whsec_".length) {
        throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
      }

      const isTestKey =
        (secret_key.startsWith("sk_test_") || secret_key.startsWith("rk_test_")) &&
        secret_key.length > 8;
      const isLiveKey =
        (secret_key.startsWith("sk_live_") || secret_key.startsWith("rk_live_")) &&
        secret_key.length > 8;

      if (environment === "staging") {
        if (!isTestKey) {
          throw new BillingUnavailable("BILLING_KEY_MODE_MISMATCH");
        }
      } else if (environment === "prod") {
        if (!isLiveKey) {
          throw new BillingUnavailable("BILLING_KEY_MODE_MISMATCH");
        }
      } else {
        throw new BillingUnavailable("BILLING_KEY_MODE_MISMATCH");
      }

      const values: BillingSecretValues = Object.defineProperties(
        {
          toJSON() {
            return {
              secretKey: "[REDACTED]",
              webhookSecret: "[REDACTED]",
            };
          },
          [util.inspect.custom]() {
            return "[BillingSecretValues <redacted>]";
          },
        } as unknown as BillingSecretValues,
        {
          secretKey: {
            value: secret_key,
            enumerable: false,
            writable: false,
          },
          webhookSecret: {
            value: webhook_secret,
            enumerable: false,
            writable: false,
          },
        },
      );

      if (currentGeneration === generation) {
        cached = values;
      }
      return values;
    })().finally(() => {
      if (inflight === promise) {
        inflight = undefined;
      }
    });

    inflight = promise;
    return inflight;
  }

  function invalidate(): void {
    generation += 1;
    cached = undefined;
    inflight = undefined;
  }

  return {
    get,
    invalidate,
  };
}
