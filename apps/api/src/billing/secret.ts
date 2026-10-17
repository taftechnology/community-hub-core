import { BillingUnavailable } from "@community-hub/billing";

export type BillingSecretReader = (
  arn: string,
  stage?: "AWSCURRENT" | "AWSPREVIOUS",
) => Promise<string>;

export type BillingSecretValues = {
  secret_key: string;
  webhook_secret: string;
  secretKey: string;
  webhookSecret: string;
};

export type BillingSecret = {
  (): Promise<BillingSecretValues>;
  get(): Promise<BillingSecretValues>;
  invalidate(): void;
};

export function billingSecret(
  readSecret: BillingSecretReader,
  arn: string,
  environment: "staging" | "prod",
): BillingSecret {
  let cached: BillingSecretValues | undefined;
  let inflight: Promise<BillingSecretValues> | undefined;

  async function get(): Promise<BillingSecretValues> {
    if (cached !== undefined) {
      return cached;
    }
    if (inflight !== undefined) {
      return inflight;
    }

    inflight = (async () => {
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

      if (!webhook_secret.startsWith("whsec_")) {
        throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
      }

      const isTestKey = secret_key.startsWith("sk_test_") || secret_key.startsWith("rk_test_");
      const isLiveKey = secret_key.startsWith("sk_live_") || secret_key.startsWith("rk_live_");

      if (environment === "staging") {
        if (!isTestKey) {
          throw new BillingUnavailable("BILLING_KEY_MODE_MISMATCH");
        }
      } else if (environment === "prod") {
        if (!isLiveKey) {
          throw new BillingUnavailable("BILLING_KEY_MODE_MISMATCH");
        }
      }

      const values: BillingSecretValues = {
        secret_key,
        webhook_secret,
        get secretKey() {
          return secret_key;
        },
        get webhookSecret() {
          return webhook_secret;
        },
      };

      cached = values;
      return values;
    })().finally(() => {
      inflight = undefined;
    });

    return inflight;
  }

  function invalidate(): void {
    cached = undefined;
    inflight = undefined;
  }

  return Object.assign(get, {
    get,
    invalidate,
  });
}
