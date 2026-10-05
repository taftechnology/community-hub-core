import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { KMSClient, type DecryptCommand, type GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import type { KmsPort } from "@community-hub/crypto";
import { createDirectSql } from "@community-hub/db";

import { IMAGE_CERT_PATH, readServiceEnv, type ServiceEnv } from "./env.js";
import { createAwsKmsPort } from "./kms/aws-kms-adapter.js";

export const STEP_MS = 10_000;

const PROBE_CONTEXT = {
  key_kind: "identity" as const,
  region: "ap-southeast-2",
  key_version: "probe",
};

type Step = "env" | "db_app" | "db_identity" | "db_platform" | "kms_generate" | "kms_decrypt";

let currentStep: Step = "env";

export function setProbeStepForTest(step: Step): void {
  currentStep = step;
}

export function handleProbeCrash(
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): void {
  stdout("fail\n");
  stderr(`${currentStep}\n`);
}

export type ProbeDeps = {
  source: NodeJS.ProcessEnv;
  pem: string;
  connect: typeof createDirectSql;
  kms: KmsPort;
  stepMs?: number;
};

export async function runProbe(deps: ProbeDeps): Promise<{
  exitCode: 0 | 1;
  stdout: "pass\n" | "fail\n";
  stderr:
    | ""
    | "env\n"
    | "db_app\n"
    | "db_identity\n"
    | "db_platform\n"
    | "kms_generate\n"
    | "kms_decrypt\n";
}> {
  currentStep = "env";
  const read = readServiceEnv(deps.source, deps.pem);
  if (!read.ok) {
    return { exitCode: 1, stdout: "fail\n", stderr: "env\n" };
  }

  const budget = deps.stepMs ?? STEP_MS;
  try {
    currentStep = "db_app";
    await limit(budget, () =>
      queryRole(deps, read.env, read.env.PGUSER_APP, read.env.PGPASSWORD_APP),
    );
    currentStep = "db_identity";
    await limit(budget, () =>
      queryRole(deps, read.env, read.env.PGUSER_IDENTITY, read.env.PGPASSWORD_IDENTITY),
    );
    currentStep = "db_platform";
    await limit(budget, () =>
      queryRole(deps, read.env, read.env.PGUSER_PLATFORM, read.env.PGPASSWORD_PLATFORM),
    );
    currentStep = "kms_generate";
    const generated = await limit(budget, () =>
      deps.kms.generateDataKey(read.env.ENVELOPE_KEY_ARN, PROBE_CONTEXT),
    );
    currentStep = "kms_decrypt";
    const opened = await limit(budget, () =>
      deps.kms.decrypt(read.env.ENVELOPE_KEY_ARN, generated.blob, PROBE_CONTEXT),
    );
    const sameLength = generated.plaintext.length === opened.length;
    const matches = sameLength && timingSafeEqual(generated.plaintext, opened);
    generated.plaintext.fill(0);
    opened.fill(0);
    if (!matches) {
      return { exitCode: 1, stdout: "fail\n", stderr: "kms_decrypt\n" };
    }
  } catch {
    return { exitCode: 1, stdout: "fail\n", stderr: `${currentStep}\n` };
  }

  return { exitCode: 0, stdout: "pass\n", stderr: "" };
}

async function queryRole(
  deps: ProbeDeps,
  env: ServiceEnv,
  user: string,
  password: string,
): Promise<void> {
  const sql = deps.connect({
    host: env.PGHOST,
    port: env.PGPORT,
    database: env.PGDATABASE,
    user,
    password,
    ca: deps.pem,
  });
  try {
    const rows = await sql`select 1 as n`;
    const first = rows[0] as { n?: number } | undefined;
    if (first?.n !== 1) {
      throw new Error("unexpected");
    }
  } finally {
    await sql.end({ timeout: 1 });
  }
}

function limit<T>(ms: number, run: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    run().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("failed"));
      },
    );
  });
}

function crash(): void {
  handleProbeCrash(
    (line) => {
      process.stdout.write(line);
    },
    (line) => {
      process.stderr.write(line);
    },
  );
  process.exit(1);
}

type ProbeClient = {
  send: (
    command: GenerateDataKeyCommand | DecryptCommand,
    sendOptions?: { abortSignal?: AbortSignal },
  ) => Promise<{ Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array }>;
};

export function startProbe(options: {
  readPem: () => string;
  source: NodeJS.ProcessEnv;
  connect: typeof createDirectSql;
  createClient: () => ProbeClient;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  exit: (code: number) => void;
}): void {
  let pem: string;
  try {
    pem = options.readPem();
  } catch {
    options.stdout("fail\n");
    options.stderr("env\n");
    options.exit(1);
    return;
  }
  const read = readServiceEnv(options.source, pem);
  const kms: KmsPort = read.ok
    ? createAwsKmsPort({
        client: options.createClient(),
        keyArn: read.env.ENVELOPE_KEY_ARN,
        info: () => {},
      })
    : {
        async generateDataKey() {
          throw new Error("kms_failed");
        },
        async decrypt() {
          throw new Error("kms_failed");
        },
      };
  void runProbe({ source: options.source, pem, connect: options.connect, kms }).then((result) => {
    options.stdout(result.stdout);
    options.stderr(result.stderr);
    options.exit(result.exitCode);
  });
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  startProbe({
    readPem: () => readFileSync(IMAGE_CERT_PATH, "utf8"),
    source: process.env,
    connect: createDirectSql,
    createClient: () => new KMSClient({ region: "ap-southeast-2", maxAttempts: 1 }) as ProbeClient,
    stdout: (line) => {
      process.stdout.write(line);
    },
    stderr: (line) => {
      process.stderr.write(line);
    },
    exit: (code) => {
      process.exit(code);
    },
  });
}
