import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { KMSClient } from "@aws-sdk/client-kms";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import type { KmsPort } from "@community-hub/crypto";
import {
  createAppSql,
  createIdentitySql,
  createPlatformSql,
  type SqlTarget,
} from "@community-hub/db";
import { rejectingOtpMail, type OtpMail } from "@community-hub/identity";
import { healthRequest } from "@community-hub/kernel";
import { type StripeBilling } from "@community-hub/billing";
import { createLogger, type LogFields, type Logger } from "@community-hub/observability";

import { authRoutes, type AuthDeps } from "./auth-routes.js";
import { accessRoutes, type AccessDeps } from "./access-routes.js";
import { entitlementRoutes, type EntitlementDeps } from "./entitlement-routes.js";
import { billingWebhookRoutes } from "./billing-webhook.js";
import { billingSecret, type BillingSecret } from "./billing/secret.js";
import { createStripeBilling, rejectingStripeBilling } from "./billing/stripe-adapter.js";
import { createCheckout } from "./checkout.js";
import { readServiceEnv, IMAGE_CERT_PATH, type ServiceEnv } from "./env.js";
import { RoutesRejected, type GateRoute } from "./gate.js";
import { createAwsKmsPort } from "./kms/aws-kms-adapter.js";
import { createSesOtpMail } from "./mail/ses-otp-mail.js";
import { secretsManagerReader } from "./secrets.js";
import { startServer } from "./server.js";

let current: Server | undefined;

const bootLogger = createLogger();

export function listeningServer(): Server | undefined {
  return current;
}

export function boot(options: {
  readPem: () => string;
  source: NodeJS.ProcessEnv;
  routes: readonly GateRoute[];
  exit: (code: number) => void;
}): void {
  let pem: string;
  try {
    pem = options.readPem();
  } catch {
    process.stderr.write("env\n");
    options.exit(1);
    return;
  }
  const code = run(options.source, pem, options.routes);
  if (code !== 0) {
    options.exit(code);
  }
}

export function run(source: NodeJS.ProcessEnv, pem: string, routes: readonly GateRoute[]): number {
  const read = readServiceEnv(source, pem);
  if (!read.ok) {
    process.stderr.write("env\n");
    return 1;
  }
  try {
    const bound = bindServices(read.env, pem);
    current = startServer({
      env: read.env,
      routes: [
        ...routes,
        ...authRoutes(bound.auth),
        ...accessRoutes(bound.access),
        ...entitlementRoutes(bound.entitlements),
        ...billingWebhookRoutes(bound.billing),
      ],
    });
  } catch (error) {
    if (error instanceof RoutesRejected) {
      process.stderr.write("routes\n");
      return 1;
    }
    throw error;
  }
  return 0;
}

const healthRoute: GateRoute = {
  method: "GET",
  pattern: "/health",
  surface: "all",
  handle: healthRequest,
};

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

export type BillingLogFields = Pick<
  LogFields,
  | "operation"
  | "outcome"
  | "organisationId"
  | "stripeEventId"
  | "stripeEventType"
  | "errorCode"
  | "errorClass"
  | "status"
  | "duration"
  | "requestId"
  | "gatewayRequestId"
  | "hostname"
  | "reason"
>;

export type BillingDeps = {
  readonly checkout: ReturnType<typeof createCheckout>;
  readonly port: StripeBilling;
  readonly now: () => Date;
  readonly apiHostname: string;
  readonly webhooksHostname: string;
  readonly adminOrigin?: string | undefined;
  readonly log: (message: string, fields?: BillingLogFields) => void;
};

export function bindServices(
  env: ServiceEnv,
  pem: string,
  logger: Logger = bootLogger,
): {
  auth: AuthDeps;
  access: AccessDeps;
  entitlements: EntitlementDeps;
  billing: BillingDeps;
} {
  const readSecret = secretsManagerReader(
    new SecretsManagerClient({ region: env.AWS_REGION }) as Parameters<
      typeof secretsManagerReader
    >[0],
  );
  const checkout = createCheckout({
    passwords: {
      app: env.PGPASSWORD_APP,
      identity: env.PGPASSWORD_IDENTITY,
      platform: env.PGPASSWORD_PLATFORM,
    },
    arns: {
      app: env.APP_SECRET_ARN,
      identity: env.IDENTITY_SECRET_ARN,
      platform: env.PLATFORM_SECRET_ARN,
    },
    open: {
      app: (password) => createAppSql(target(env, pem, env.PGUSER_APP, password)),
      identity: (password) => createIdentitySql(target(env, pem, env.PGUSER_IDENTITY, password)),
      platform: (password) => createPlatformSql(target(env, pem, env.PGUSER_PLATFORM, password)),
    },
    readSecret,
    log: () => undefined,
  });
  let kms: KmsPort | undefined;
  const shared = {
    checkout,
    get kms() {
      kms ??= createAwsKmsPort({
        client: new KMSClient({ region: env.AWS_REGION, maxAttempts: 1 }) as Parameters<
          typeof createAwsKmsPort
        >[0]["client"],
        keyArn: env.ENVELOPE_KEY_ARN,
        // The adapter reports only an operation, a key kind and an outcome, each a fixed value.
        info: (fields) => {
          logger.info("kms", fields);
        },
      });
      return kms;
    },
    keyArn: env.ENVELOPE_KEY_ARN,
    now: () => new Date(),
    log: () => undefined,
  };
  let sesClient: SESv2Client | undefined;
  const mail: OtpMail =
    env.MAIL_FROM_ADDRESS !== undefined && env.SES_CONFIGURATION_SET !== undefined
      ? createSesOtpMail({
          client: () => {
            sesClient ??= new SESv2Client({ region: env.AWS_REGION, maxAttempts: 1 });
            return sesClient;
          },
          from: env.MAIL_FROM_ADDRESS,
          configurationSet: env.SES_CONFIGURATION_SET,
          info: (fields) => {
            logger.info("mail", fields);
          },
        })
      : rejectingOtpMail;

  let billingSecretInstance: BillingSecret | undefined;
  let billingPort: StripeBilling | undefined;
  const billingLog = (message: string, fields?: BillingLogFields) => {
    logger.info(message, fields);
  };
  if (env.BILLING_SECRET_ARN !== undefined && env.ADMIN_ORIGIN !== undefined) {
    billingSecretInstance = billingSecret(
      (arn, stage = "AWSCURRENT") => readSecret(arn, stage),
      env.BILLING_SECRET_ARN,
      env.COMMUNITY_HUB_ENVIRONMENT,
    );
  }

  const billing: BillingDeps = {
    checkout,
    get port() {
      if (billingSecretInstance === undefined) {
        return rejectingStripeBilling;
      }
      billingPort ??= createStripeBilling({
        secret: billingSecretInstance,
        info: (fields) => {
          logger.info("stripe", fields);
        },
      });
      return billingPort;
    },
    now: shared.now,
    apiHostname: env.API_HOSTNAME,
    webhooksHostname: env.WEBHOOKS_HOSTNAME,
    adminOrigin: env.ADMIN_ORIGIN,
    log: billingLog,
  };

  return {
    auth: {
      checkout: shared.checkout,
      get kms() {
        return shared.kms;
      },
      keyArn: shared.keyArn,
      mail,
      now: shared.now,
      authHostname: env.AUTH_HOSTNAME,
      log: shared.log,
    },
    access: {
      checkout: shared.checkout,
      get kms() {
        return shared.kms;
      },
      keyArn: shared.keyArn,
      now: shared.now,
      apiHostname: env.API_HOSTNAME,
      log: shared.log,
    },
    entitlements: {
      checkout: shared.checkout,
      get kms() {
        return shared.kms;
      },
      keyArn: shared.keyArn,
      now: shared.now,
      apiHostname: env.API_HOSTNAME,
      log: shared.log,
    },
    billing,
  };
}

export function productionRoutes(env: ServiceEnv, pem: string): readonly GateRoute[] {
  const bound = bindServices(env, pem);
  return [
    healthRoute,
    ...authRoutes(bound.auth),
    ...accessRoutes(bound.access),
    ...entitlementRoutes(bound.entitlements),
    ...billingWebhookRoutes(bound.billing),
  ];
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  boot({
    readPem: () => readFileSync(IMAGE_CERT_PATH, "utf8"),
    source: process.env,
    routes: [healthRoute],
    exit: (code) => {
      process.exit(code);
    },
  });
}
