import { createHash } from "node:crypto";

export const CERT_SHA256 = "d73890748b5a95551800df8a6f07c9c800e32ed34da7e6c9505918bf8ac2398b";
export const IMAGE_CERT_PATH = "/app/certs/rds-ap-southeast-2-bundle.pem";

const ARN =
  /^arn:aws:kms:ap-southeast-2:[0-9]{12}:key\/(mrk-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const REQUIRED = [
  "AWS_REGION",
  "NODE_ENV",
  "COMMUNITY_HUB_ENVIRONMENT",
  "API_HOSTNAME",
  "AUTH_HOSTNAME",
  "WEBHOOKS_HOSTNAME",
  "OPS_HOSTNAME",
  "PGHOST",
  "PGDATABASE",
  "PGUSER_APP",
  "PGUSER_IDENTITY",
  "PGUSER_PLATFORM",
  "PGPASSWORD_APP",
  "PGPASSWORD_IDENTITY",
  "PGPASSWORD_PLATFORM",
  "ENVELOPE_KEY_ARN",
  "APP_SECRET_ARN",
  "IDENTITY_SECRET_ARN",
  "PLATFORM_SECRET_ARN",
] as const;

export type ServiceEnv = {
  PORT: number;
  PGPORT: number;
  AWS_REGION: "ap-southeast-2";
  NODE_ENV: "production" | "test";
  COMMUNITY_HUB_ENVIRONMENT: "staging" | "prod";
  API_HOSTNAME: string;
  AUTH_HOSTNAME: string;
  WEBHOOKS_HOSTNAME: string;
  OPS_HOSTNAME: string;
  PGHOST: string;
  PGDATABASE: string;
  PGUSER_APP: string;
  PGUSER_IDENTITY: string;
  PGUSER_PLATFORM: string;
  PGPASSWORD_APP: string;
  PGPASSWORD_IDENTITY: string;
  PGPASSWORD_PLATFORM: string;
  ENVELOPE_KEY_ARN: string;
  APP_SECRET_ARN: string;
  IDENTITY_SECRET_ARN: string;
  PLATFORM_SECRET_ARN: string;
};

function text(source: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return value;
}

function portNumber(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return undefined;
  }
  return parsed;
}

export function readServiceEnv(
  source: NodeJS.ProcessEnv,
  pem: string,
): { ok: true; env: ServiceEnv } | { ok: false } {
  const values: Record<string, string> = {};
  for (const key of REQUIRED) {
    const value = text(source, key);
    if (value === undefined) {
      return { ok: false };
    }
    values[key] = value;
  }

  const port = portNumber(text(source, "PORT"));
  const pgPort = portNumber(text(source, "PGPORT"));
  if (port === undefined || pgPort === undefined) {
    return { ok: false };
  }
  const nodeEnv = values.NODE_ENV;
  const hubEnv = values.COMMUNITY_HUB_ENVIRONMENT;
  if (values.AWS_REGION !== "ap-southeast-2") {
    return { ok: false };
  }
  if (nodeEnv !== "production" && nodeEnv !== "test") {
    return { ok: false };
  }
  if (hubEnv !== "staging" && hubEnv !== "prod") {
    return { ok: false };
  }

  const hostnames = [
    values.API_HOSTNAME,
    values.AUTH_HOSTNAME,
    values.WEBHOOKS_HOSTNAME,
    values.OPS_HOSTNAME,
  ].map((hostname) => (hostname ?? "").toLowerCase());
  if (new Set(hostnames).size !== hostnames.length) {
    return { ok: false };
  }
  if (!ARN.test(values.ENVELOPE_KEY_ARN ?? "")) {
    return { ok: false };
  }
  const digest = createHash("sha256").update(pem).digest("hex");
  if (digest !== CERT_SHA256) {
    return { ok: false };
  }

  return {
    ok: true,
    env: {
      PORT: port,
      PGPORT: pgPort,
      AWS_REGION: "ap-southeast-2",
      NODE_ENV: nodeEnv,
      COMMUNITY_HUB_ENVIRONMENT: hubEnv,
      API_HOSTNAME: values.API_HOSTNAME ?? "",
      AUTH_HOSTNAME: values.AUTH_HOSTNAME ?? "",
      WEBHOOKS_HOSTNAME: values.WEBHOOKS_HOSTNAME ?? "",
      OPS_HOSTNAME: values.OPS_HOSTNAME ?? "",
      PGHOST: values.PGHOST ?? "",
      PGDATABASE: values.PGDATABASE ?? "",
      PGUSER_APP: values.PGUSER_APP ?? "",
      PGUSER_IDENTITY: values.PGUSER_IDENTITY ?? "",
      PGUSER_PLATFORM: values.PGUSER_PLATFORM ?? "",
      PGPASSWORD_APP: values.PGPASSWORD_APP ?? "",
      PGPASSWORD_IDENTITY: values.PGPASSWORD_IDENTITY ?? "",
      PGPASSWORD_PLATFORM: values.PGPASSWORD_PLATFORM ?? "",
      ENVELOPE_KEY_ARN: values.ENVELOPE_KEY_ARN ?? "",
      APP_SECRET_ARN: values.APP_SECRET_ARN ?? "",
      IDENTITY_SECRET_ARN: values.IDENTITY_SECRET_ARN ?? "",
      PLATFORM_SECRET_ARN: values.PLATFORM_SECRET_ARN ?? "",
    },
  };
}
