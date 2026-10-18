import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  currentSettings,
  deriveState,
  insertSettings,
  readAccount,
  setMode,
  syncQuantity,
  type BillingMode,
  type StripeBilling,
} from "@community-hub/billing";
import { createPlatformSql, newId, type SqlTarget } from "@community-hub/db";
import { setPlanBilling, upsertPlan } from "@community-hub/entitlements";
import { findOrganisationBySlug, listCommunityIds } from "@community-hub/tenancy";

type Sql = ReturnType<typeof createPlatformSql>;

import { billingSecret, type BillingSecret } from "./billing/secret.js";
import { createStripeBilling } from "./billing/stripe-adapter.js";
import { IMAGE_CERT_PATH, readServiceEnv, type ServiceEnv } from "./env.js";
import { secretsManagerReader } from "./secrets.js";

/** Node/postgres.js connection-level error codes that are a `connect` failure. */
const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

function isConnectionError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_CODES.has(code)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Test-mode placeholder amounts in cents (Q8b).
 * Real amounts are product data set in Stripe and never committed to this repository.
 */
const TEST_MODE_PLACEHOLDER_AMOUNTS_CENTS: Readonly<Record<string, number>> = {
  starter_monthly: 1000,
  growth_monthly: 2000,
  ecommerce_monthly: 500,
  website_monthly: 500,
  mobile_monthly: 500,
  branded_monthly: 500,
  sms_pack_monthly: 500,
};

const SEED_CATALOGUE_ITEMS = [
  { key: "starter_monthly", name: "Starter" },
  { key: "growth_monthly", name: "Growth" },
  { key: "ecommerce_monthly", name: "Ecommerce" },
  { key: "website_monthly", name: "Website" },
  { key: "mobile_monthly", name: "Mobile" },
  { key: "branded_monthly", name: "Branded" },
  { key: "sms_pack_monthly", name: "SMS Pack" },
] as const;

export type BillingAdminDeps = {
  args: string[];
  platform: Sql;
  stripe: StripeBilling;
  secret: BillingSecret;
  now?: () => Date;
};

export type BillingAdminResult = {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
};

function ok(stdout: string): BillingAdminResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failed(stderr: string): BillingAdminResult {
  return { exitCode: 1, stdout: "", stderr };
}

function parseFlags(args: string[]): {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string>;
  booleanFlags: Set<string>;
} {
  const command = args[0];
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const booleanFlags = new Set<string>();

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(arg, next);
        i++;
      } else {
        booleanFlags.add(arg);
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags, booleanFlags };
}

export async function runBillingAdmin(deps: BillingAdminDeps): Promise<BillingAdminResult> {
  const { command, positional, flags, booleanFlags } = parseFlags(deps.args);

  if (command === undefined) {
    return failed("invalid_argument\n");
  }

  try {
    switch (command) {
      case "settings": {
        const gstBpsRaw = flags.get("--gst-bps");
        const inclusiveRaw = flags.get("--inclusive");
        const trialDaysRaw = flags.get("--trial-days");
        const graceDaysRaw = flags.get("--grace-days");
        const note = flags.get("--note");

        if (
          gstBpsRaw === undefined ||
          inclusiveRaw === undefined ||
          trialDaysRaw === undefined ||
          graceDaysRaw === undefined ||
          note === undefined
        ) {
          return failed("invalid_argument\n");
        }

        const gstBps = Number(gstBpsRaw);
        if (!Number.isInteger(gstBps) || gstBps < 0 || gstBps > 5000) {
          return failed("invalid_argument\n");
        }

        if (inclusiveRaw !== "true" && inclusiveRaw !== "false") {
          return failed("invalid_argument\n");
        }
        const inclusive = inclusiveRaw === "true";

        const trialDays = Number(trialDaysRaw);
        if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 90) {
          return failed("invalid_argument\n");
        }

        const graceDays = Number(graceDaysRaw);
        if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 30) {
          return failed("invalid_argument\n");
        }

        // Note: at most 200 printable ASCII characters, no newline
        if (
          note.length > 200 ||
          note.includes("\n") ||
          note.includes("\r") ||
          !/^[\x20-\x7E]*$/.test(note)
        ) {
          return failed("invalid_argument\n");
        }

        const rowId = newId();
        const percentage = gstBps / 100;

        // Security pin 27: createTaxRate MUST happen before insertSettings
        const taxRate = await deps.stripe.createTaxRate({
          percentage,
          inclusive,
          country: "AU",
          displayName: "GST",
          idempotencyKey: `taxrate:${rowId}`,
        });

        await insertSettings(deps.platform, {
          id: rowId,
          gstRateBps: gstBps,
          pricesIncludeGst: inclusive,
          trialDays,
          graceDays,
          stripeTaxRateId: taxRate.id,
          note,
        });

        return ok(`tax_rate ${taxRate.id}\n`);
      }

      case "sync": {
        const slug = positional[0];
        if (slug === undefined) {
          return failed("invalid_argument\n");
        }

        const org = await findOrganisationBySlug(deps.platform, slug);
        if (org === null) {
          return failed("organisation\n");
        }

        const account = await readAccount(deps.platform, org.id);
        if (account === null || account.stripeSubscriptionId === null) {
          return failed("not_linked\n");
        }

        const communityIds = await listCommunityIds(deps.platform, org.id);
        const n = communityIds.length;
        const reqId = newId();
        const idempotencyKey = `qty:${account.stripeSubscriptionId}:${n}:${reqId}`;

        await syncQuantity(deps.platform, deps.stripe, org.id, idempotencyKey);
        return ok("synced\n");
      }

      case "apply-tax-rate": {
        const slug = positional[0];
        if (slug === undefined) {
          return failed("invalid_argument\n");
        }

        const org = await findOrganisationBySlug(deps.platform, slug);
        if (org === null) {
          return failed("organisation\n");
        }

        const settings = await currentSettings(deps.platform);
        if (settings === null || settings.stripeTaxRateId === null) {
          return failed("settings\n");
        }

        const account = await readAccount(deps.platform, org.id);
        if (account === null || account.stripeSubscriptionId === null) {
          return failed("not_linked\n");
        }

        const idempotencyKey = `taxmove:${account.stripeSubscriptionId}:${settings.id}`;

        await deps.stripe.updateDefaultTaxRate({
          subscriptionId: account.stripeSubscriptionId,
          taxRateId: settings.stripeTaxRateId,
          idempotencyKey,
        });

        await deps.platform`
          update platform.billing_accounts
          set tax_rate_id = ${settings.stripeTaxRateId}
          where organisation_id = ${org.id}::uuid
        `;

        return ok("applied\n");
      }

      case "mode": {
        const slug = positional[0];
        const targetMode = positional[1] as BillingMode | undefined;
        const hasCancelledFlag = booleanFlags.has("--subscription-cancelled-in-stripe");

        if (slug === undefined || (targetMode !== "self_serve" && targetMode !== "invoiced")) {
          return failed("invalid_argument\n");
        }

        const org = await findOrganisationBySlug(deps.platform, slug);
        if (org === null) {
          return failed("organisation\n");
        }

        const account = await readAccount(deps.platform, org.id);

        // Security pin 28 (D12 guard): mode invoiced refuses a live subscription without the flag
        if (targetMode === "invoiced") {
          const hasLiveSubscription =
            account?.stripeSubscriptionId != null &&
            account.stripeStatus != null &&
            account.stripeStatus !== "canceled" &&
            account.stripeStatus !== "incomplete_expired";

          if (hasLiveSubscription && !hasCancelledFlag) {
            return failed("refused\n");
          }
        }

        const updated = await setMode(deps.platform, org.id, targetMode);
        const now = deps.now ? deps.now() : new Date();
        const state = deriveState(updated, now);

        return ok(`${state}\n`);
      }

      case "plan": {
        const key = positional[0];
        const lookupKey = flags.get("--lookup-key");
        const trialEligibleRaw = flags.get("--trial-eligible");
        const entitlementsRaw = flags.get("--entitlements");

        if (
          key === undefined ||
          lookupKey === undefined ||
          trialEligibleRaw === undefined ||
          (trialEligibleRaw !== "true" && trialEligibleRaw !== "false")
        ) {
          return failed("invalid_argument\n");
        }

        // Plan key: ^[a-z][a-z0-9_]{1,31}$
        if (!/^[a-z][a-z0-9_]{1,31}$/.test(key)) {
          return failed("invalid_argument\n");
        }

        // Lookup key: ^[a-z][a-z0-9_]{1,63}$
        if (!/^[a-z][a-z0-9_]{1,63}$/.test(lookupKey)) {
          return failed("invalid_argument\n");
        }

        const trialEligible = trialEligibleRaw === "true";
        const entitlementsList = entitlementsRaw
          ? entitlementsRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
              .map((k) => ({ key: k, limit: null }))
          : [];

        await upsertPlan(deps.platform, { key, entitlements: entitlementsList });
        await setPlanBilling(deps.platform, key, {
          stripeLookupKey: lookupKey,
          trialEligible,
        });

        return ok("plan_set\n");
      }

      case "seed-test-catalogue": {
        const secretValues = await deps.secret.get();
        const key = secretValues.secretKey;
        const isTestMode =
          (key.startsWith("sk_test_") || key.startsWith("rk_test_")) && key.length > 8;

        // Security pin 28: seed-test-catalogue refuses a live key
        if (!isTestMode) {
          return failed("refused\n");
        }

        const settings = await currentSettings(deps.platform);
        if (settings === null) {
          return failed("settings\n");
        }

        const taxBehavior = settings.pricesIncludeGst ? "inclusive" : "exclusive";

        for (const item of SEED_CATALOGUE_ITEMS) {
          const product = await deps.stripe.ensureProduct({
            name: item.name,
            lookupKey: item.key,
            idempotencyKey: `seed:product:${item.key}`,
          });

          await deps.stripe.ensurePrice({
            productId: product.id,
            lookupKey: item.key,
            currency: "aud",
            unitAmount: TEST_MODE_PLACEHOLDER_AMOUNTS_CENTS[item.key]!,
            interval: "month",
            taxBehavior,
            idempotencyKey: `seed:price:${item.key}`,
          });
        }

        return ok("seeded\n");
      }

      default:
        return failed("invalid_argument\n");
    }
  } catch (error) {
    if (isConnectionError(error)) {
      return failed("connect\n");
    }
    return failed("fail\n");
  }
}

export async function runBillingAdminMain(deps: BillingAdminDeps): Promise<BillingAdminResult> {
  try {
    return await runBillingAdmin(deps);
  } catch {
    return failed("fail\n");
  }
}

function target(env: ServiceEnv, pem: string, user: string, password: string): SqlTarget {
  return {
    host: env.PGHOST,
    port: env.PGPORT,
    database: env.PGDATABASE,
    user,
    password,
    ca: pem,
  };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void (async (): Promise<void> => {
    let result: BillingAdminResult;
    let pem: string;
    try {
      pem = readFileSync(IMAGE_CERT_PATH, "utf8");
    } catch {
      process.stderr.write("env\n");
      process.exit(1);
    }
    const read = readServiceEnv(process.env, pem);
    if (!read.ok) {
      process.stderr.write("env\n");
      process.exit(1);
    }
    const env = read.env;
    const platform = createPlatformSql(
      target(env, pem, env.PGUSER_PLATFORM, env.PGPASSWORD_PLATFORM),
    );
    const reader = secretsManagerReader(
      new SecretsManagerClient({ region: env.AWS_REGION }) as Parameters<
        typeof secretsManagerReader
      >[0],
    );
    const secret = billingSecret(
      (arn, stage) => reader(arn, stage ?? "AWSCURRENT"),
      env.BILLING_SECRET_ARN ?? "",
      env.COMMUNITY_HUB_ENVIRONMENT === "prod" ? "prod" : "staging",
    );
    const stripe = createStripeBilling({ secret });
    try {
      result = await runBillingAdminMain({
        args: process.argv.slice(2),
        platform,
        stripe,
        secret,
        now: () => new Date(),
      });
    } finally {
      await platform.end({ timeout: 1 }).catch(() => undefined);
    }
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  })();
}
