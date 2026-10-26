import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { KMSClient } from "@aws-sdk/client-kms";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { KmsPort } from "@community-hub/crypto";
import { createIdentitySql, newId, type SqlTarget } from "@community-hub/db";
import {
  findOrCreateUserByEmail,
  findUserByEmail,
  grantOperator,
  IdentityError,
  recoverOperator,
  revokeOperator,
} from "@community-hub/identity";

import { IMAGE_CERT_PATH, readServiceEnv, type ServiceEnv } from "./env.js";
import { createAwsKmsPort } from "./kms/aws-kms-adapter.js";
import { classify, PROVISION_SECRET_ARN } from "./one-off-failure.js";
import { secretsManagerReader } from "./secrets.js";

/** The `postgres` Sql type, taken from a db export so this package need not depend on `postgres`. */
type Sql = ReturnType<typeof createIdentitySql>;

export type OpsOperatorDeps = {
  /** The task's environment. Only `PROVISION_SECRET_ARN` is ever read from it. */
  source: NodeJS.ProcessEnv;
  /** Reads the secret value for an ARN. Never given anything but the validated ARN. */
  readSecret: (arn: string) => Promise<string>;
  identity: Sql;
  kms: KmsPort;
  keyArn: string;
  opsRpId: string;
  now: () => Date;
  newId: () => string;
};

export type OpsOperatorResult = {
  exitCode: 0 | 1;
  stdout: "" | "granted\n" | "revoked\n" | "recovered\n";
  stderr: string;
};

function ok(stdout: "granted\n" | "revoked\n" | "recovered\n"): OpsOperatorResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failed(stderr: string): OpsOperatorResult {
  return { exitCode: 1, stdout: "", stderr };
}

const PLATFORM_ROLES = new Set(["platform_admin", "platform_support", "platform_security"]);
const ENROLMENT_CODE_REGEX = /^[A-Za-z2-7]{26,128}$/;

function validatePreCheck(roleKeys: readonly string[], enrolmentCode: string): boolean {
  if (roleKeys.length === 0) {
    return false;
  }
  const seen = new Set<string>();
  for (const role of roleKeys) {
    if (!PLATFORM_ROLES.has(role) || seen.has(role)) {
      return false;
    }
    seen.add(role);
  }
  const stripped = enrolmentCode.replace(/[ -]/g, "");
  return ENROLMENT_CODE_REGEX.test(stripped);
}

type OpsOperatorSecret =
  | { action: "grant"; email: string; roleKeys: string[]; enrolmentCode: string }
  | { action: "revoke"; email: string }
  | { action: "recover"; email: string; roleKeys: string[]; enrolmentCode: string };

function parseSecret(raw: string): "shape" | "secret" | OpsOperatorSecret {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "secret";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "secret";
  }
  const topKeys = Object.keys(value);
  if (topKeys.length !== 1 || !Object.hasOwn(value, "opsOperator")) {
    return "shape";
  }
  const op = (value as Record<string, unknown>).opsOperator;
  if (typeof op !== "object" || op === null || Array.isArray(op)) {
    return "shape";
  }
  const opRecord = op as Record<string, unknown>;
  const opKeys = Object.keys(opRecord);
  for (const key of opKeys) {
    if (key !== "action" && key !== "email" && key !== "roleKeys" && key !== "enrolmentCode") {
      return "shape";
    }
  }
  const { action, email } = opRecord;
  if (action !== "grant" && action !== "revoke" && action !== "recover") {
    return "shape";
  }
  if (typeof email !== "string" || email.length === 0) {
    return "shape";
  }
  if (action === "revoke") {
    if (Object.hasOwn(opRecord, "roleKeys") || Object.hasOwn(opRecord, "enrolmentCode")) {
      return "shape";
    }
    if (opKeys.length !== 2) {
      return "shape";
    }
    return { action: "revoke", email };
  }
  if (opKeys.length !== 4) {
    return "shape";
  }
  const { roleKeys, enrolmentCode } = opRecord;
  if (
    !Array.isArray(roleKeys) ||
    roleKeys.length === 0 ||
    !roleKeys.every((k) => typeof k === "string") ||
    typeof enrolmentCode !== "string" ||
    enrolmentCode.length === 0
  ) {
    return "shape";
  }
  return { action, email, roleKeys, enrolmentCode };
}

export async function runOpsOperator(deps: OpsOperatorDeps): Promise<OpsOperatorResult> {
  const arn = deps.source.PROVISION_SECRET_ARN;
  if (arn === undefined || arn.length === 0 || !PROVISION_SECRET_ARN.test(arn)) {
    return failed("env\n");
  }

  let raw: string;
  try {
    raw = await deps.readSecret(arn);
  } catch {
    return failed("secret\n");
  }

  const parsed = parseSecret(raw);
  if (parsed === "secret") {
    return failed("secret\n");
  }
  if (parsed === "shape") {
    return failed("shape\n");
  }

  if (parsed.action === "grant" || parsed.action === "recover") {
    if (!validatePreCheck(parsed.roleKeys, parsed.enrolmentCode)) {
      return failed("refused\n");
    }
  }

  try {
    if (parsed.action === "grant") {
      const { userId } = await findOrCreateUserByEmail(deps.identity, deps.kms, deps.keyArn, {
        email: parsed.email,
      });
      await grantOperator(deps.identity, deps.kms, deps.keyArn, {
        userId,
        roleKeys: parsed.roleKeys,
        enrolmentCode: parsed.enrolmentCode,
        opsRpId: deps.opsRpId,
        now: deps.now(),
        requestId: deps.newId(),
      });
      return ok("granted\n");
    }

    const found = await findUserByEmail(deps.identity, deps.kms, deps.keyArn, {
      email: parsed.email,
    });
    if (found === null) {
      return failed("user\n");
    }

    if (parsed.action === "revoke") {
      await revokeOperator(deps.identity, {
        userId: found.userId,
        opsRpId: deps.opsRpId,
        now: deps.now(),
        requestId: deps.newId(),
      });
      return ok("revoked\n");
    }

    await recoverOperator(deps.identity, deps.kms, deps.keyArn, {
      userId: found.userId,
      roleKeys: parsed.roleKeys,
      enrolmentCode: parsed.enrolmentCode,
      opsRpId: deps.opsRpId,
      now: deps.now(),
      requestId: deps.newId(),
    });
    return ok("recovered\n");
  } catch (error) {
    if (error instanceof IdentityError) {
      return failed("refused\n");
    }
    return failed(classify(error));
  }
}

/**
 * The top-level backstop. `runOpsOperator` already classifies the failures it
 * expects, but if it throws for any other reason — a bug, an unexpected rejection
 * from a dependency — that would otherwise surface as an unhandled rejection and
 * print a message or stack trace. This catches any such throw and returns the fixed
 * `fail` contract instead, reading nothing from the error. The connection-close
 * `finally` still wraps the call at the entrypoint below.
 */
export async function runOpsOperatorMain(
  deps: OpsOperatorDeps & { run?: typeof runOpsOperator },
): Promise<OpsOperatorResult> {
  const run = deps.run ?? runOpsOperator;
  try {
    return await run(deps);
  } catch {
    return failed("fail\n");
  }
}

export function opsRpIdFrom(env: { OPS_HOSTNAME: string }): string {
  return env.OPS_HOSTNAME.toLowerCase();
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
    let result: OpsOperatorResult;
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
    const identity = createIdentitySql(
      target(env, pem, env.PGUSER_IDENTITY, env.PGPASSWORD_IDENTITY),
    );
    const reader = secretsManagerReader(
      new SecretsManagerClient({ region: env.AWS_REGION }) as Parameters<
        typeof secretsManagerReader
      >[0],
    );
    const kms = createAwsKmsPort({
      client: new KMSClient({ region: env.AWS_REGION, maxAttempts: 1 }) as Parameters<
        typeof createAwsKmsPort
      >[0]["client"],
      keyArn: env.ENVELOPE_KEY_ARN,
      info: () => undefined,
    });
    try {
      result = await runOpsOperatorMain({
        source: process.env,
        readSecret: (arn) => reader(arn, "AWSCURRENT"),
        identity,
        kms,
        keyArn: env.ENVELOPE_KEY_ARN,
        opsRpId: opsRpIdFrom(env),
        now: () => new Date(),
        newId,
      });
    } finally {
      await identity.end({ timeout: 1 }).catch(() => undefined);
    }
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  })();
}
