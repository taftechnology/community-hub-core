import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { KMSClient } from "@aws-sdk/client-kms";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { KmsPort } from "@community-hub/crypto";
import {
  createAppSql,
  createIdentitySql,
  createPlatformSql,
  type SqlTarget,
} from "@community-hub/db";
import { rejectingOtpMail } from "@community-hub/identity";
import { healthRequest } from "@community-hub/kernel";

import { authRoutes, type AuthDeps } from "./auth-routes.js";
import { accessRoutes, type AccessDeps } from "./access-routes.js";
import { entitlementRoutes, type EntitlementDeps } from "./entitlement-routes.js";
import { createCheckout } from "./checkout.js";
import { readServiceEnv, IMAGE_CERT_PATH, type ServiceEnv } from "./env.js";
import { RoutesRejected, type GateRoute } from "./gate.js";
import { createAwsKmsPort } from "./kms/aws-kms-adapter.js";
import { secretsManagerReader } from "./secrets.js";
import { startServer } from "./server.js";

let current: Server | undefined;

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

function bindServices(
  env: ServiceEnv,
  pem: string,
): { auth: AuthDeps; access: AccessDeps; entitlements: EntitlementDeps } {
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
    readSecret: secretsManagerReader(
      new SecretsManagerClient({ region: env.AWS_REGION }) as Parameters<
        typeof secretsManagerReader
      >[0],
    ),
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
        info: () => undefined,
      });
      return kms;
    },
    keyArn: env.ENVELOPE_KEY_ARN,
    now: () => new Date(),
    log: () => undefined,
  };
  return {
    auth: {
      checkout: shared.checkout,
      get kms() {
        return shared.kms;
      },
      keyArn: shared.keyArn,
      mail: rejectingOtpMail,
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
  };
}

export function productionRoutes(env: ServiceEnv, pem: string): readonly GateRoute[] {
  const bound = bindServices(env, pem);
  return [
    healthRoute,
    ...authRoutes(bound.auth),
    ...accessRoutes(bound.access),
    ...entitlementRoutes(bound.entitlements),
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
