import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { KMSClient } from "@aws-sdk/client-kms";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { bootstrapOwner, findOwner } from "@community-hub/access";
import type { KmsPort } from "@community-hub/crypto";
import {
  createAppSql,
  createIdentitySql,
  createPlatformSql,
  newId,
  withAppTransaction,
  type SqlTarget,
} from "@community-hub/db";
import { findOrCreateUserByEmail, findUserByEmail } from "@community-hub/identity";
import { withRequest } from "@community-hub/kernel";
import {
  createImplicitOrganisation,
  findCommunityBySlug,
  findOrganisationBySlug,
} from "@community-hub/tenancy";

import { IMAGE_CERT_PATH, readServiceEnv, type ServiceEnv } from "./env.js";
import { createAwsKmsPort } from "./kms/aws-kms-adapter.js";
import { classify, PROVISION_SECRET_ARN } from "./one-off-failure.js";
import { secretsManagerReader } from "./secrets.js";

/** The `postgres` Sql type, taken from a db export so this package need not depend on `postgres`. */
type Sql = ReturnType<typeof createPlatformSql>;

export type ProvisionOwnerDeps = {
  /** The task's environment. Only `PROVISION_SECRET_ARN` is ever read from it. */
  source: NodeJS.ProcessEnv;
  /** Reads the secret value for an ARN. Never given anything but the validated ARN. */
  readSecret: (arn: string) => Promise<string>;
  platform: Sql;
  app: Sql;
  identity: Sql;
  kms: KmsPort;
  keyArn: string;
  now: () => Date;
};

export type ProvisionOwnerResult = {
  exitCode: 0 | 1;
  stdout: "" | "created\n" | "already_bootstrapped\n";
  stderr: string;
};

type SecretInput = { organisationSlug: string; communitySlug: string; email: string };

function ok(stdout: "created\n" | "already_bootstrapped\n"): ProvisionOwnerResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failed(stderr: string): ProvisionOwnerResult {
  return { exitCode: 1, stdout: "", stderr };
}

/** Parses the secret JSON, returning undefined unless all three fields are present. */
function parseSecret(raw: string): SecretInput | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const { organisationSlug, communitySlug, email } = record;
  if (
    typeof organisationSlug !== "string" ||
    organisationSlug.length === 0 ||
    typeof communitySlug !== "string" ||
    communitySlug.length === 0 ||
    typeof email !== "string" ||
    email.length === 0
  ) {
    return undefined;
  }
  return { organisationSlug, communitySlug, email };
}

type Outcome = "created" | "already_bootstrapped" | "owner";

export async function runProvisionOwner(deps: ProvisionOwnerDeps): Promise<ProvisionOwnerResult> {
  const arn = deps.source.PROVISION_SECRET_ARN;
  if (arn === undefined || arn.length === 0 || !PROVISION_SECRET_ARN.test(arn)) {
    return failed("env\n");
  }

  let input: SecretInput | undefined;
  try {
    input = parseSecret(await deps.readSecret(arn));
  } catch {
    return failed("secret\n");
  }
  if (input === undefined) {
    return failed("secret\n");
  }
  const { organisationSlug, communitySlug, email } = input;

  try {
    const organisation = await findOrganisationBySlug(deps.platform, organisationSlug);
    const community = await findCommunityBySlug(deps.platform, communitySlug);

    let scope: { orgId: string; communityId: string };
    if (organisation === null && community === null) {
      const created = await createImplicitOrganisation(deps.platform, {
        organisationSlug,
        communitySlug,
      });
      scope = { orgId: created.organisationId, communityId: created.communityId };
    } else if (
      organisation !== null &&
      community !== null &&
      community.organisationId === organisation.id
    ) {
      scope = { orgId: organisation.id, communityId: community.id };
    } else {
      // One exists without the other, or they do not match: refuse, create nothing.
      return failed("organisation\n");
    }

    const outcome = await withRequest({ requestId: newId() }, () =>
      withAppTransaction(deps.app, scope, async (tx): Promise<Outcome> => {
        // The existing-owner check runs before any create, so a second run naming a
        // different email refuses rather than creating a stray identity.users row.
        const owner = await findOwner(tx);
        if (owner === null) {
          const { userId } = await findOrCreateUserByEmail(deps.identity, deps.kms, deps.keyArn, {
            email,
          });
          await bootstrapOwner(tx, { now: deps.now(), userId, actorUserId: userId });
          return "created";
        }
        // Read-only lookup only — never the create path.
        const found = await findUserByEmail(deps.identity, deps.kms, deps.keyArn, { email });
        if (found !== null && found.userId === owner.userId) {
          return "already_bootstrapped";
        }
        return "owner";
      }),
    );

    if (outcome === "owner") {
      return failed("owner\n");
    }
    return ok(outcome === "created" ? "created\n" : "already_bootstrapped\n");
  } catch (error) {
    return failed(classify(error));
  }
}

/**
 * The top-level backstop. `runProvisionOwner` already classifies the failures it
 * expects, but if it throws for any other reason — a bug, an unexpected rejection
 * from a dependency — that would otherwise surface as an unhandled rejection and
 * print a message or stack trace. This catches any such throw and returns the fixed
 * `fail` contract instead, reading nothing from the error. The connection-close
 * `finally` still wraps the call at the entrypoint below.
 */
export async function runProvisionOwnerMain(
  deps: ProvisionOwnerDeps & { run?: typeof runProvisionOwner },
): Promise<ProvisionOwnerResult> {
  const run = deps.run ?? runProvisionOwner;
  try {
    return await run(deps);
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
    let result: ProvisionOwnerResult;
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
    const app = createAppSql(target(env, pem, env.PGUSER_APP, env.PGPASSWORD_APP));
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
      result = await runProvisionOwnerMain({
        source: process.env,
        readSecret: (arn) => reader(arn, "AWSCURRENT"),
        platform,
        app,
        identity,
        kms,
        keyArn: env.ENVELOPE_KEY_ARN,
        now: () => new Date(),
      });
    } finally {
      await Promise.all([
        platform.end({ timeout: 1 }).catch(() => undefined),
        app.end({ timeout: 1 }).catch(() => undefined),
        identity.end({ timeout: 1 }).catch(() => undefined),
      ]);
    }
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  })();
}
