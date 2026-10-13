import { readFileSync } from "node:fs";

import { IMAGE_CERT_PATH, portNumber, text } from "./env.js";

export type OpsEnv = {
  host: string;
  port: number;
  database: string;
  user: string;
  master: string;
  app: string;
  identity: string;
  platform: string;
};

/** The eight variables of the ops task definition. Any gap or a bad port gives undefined. */
export function readOpsEnv(source: NodeJS.ProcessEnv): OpsEnv | undefined {
  const host = text(source, "PGHOST");
  const port = portNumber(text(source, "PGPORT"));
  const database = text(source, "PGDATABASE");
  const user = text(source, "PGUSER");
  const master = text(source, "PGPASSWORD_MASTER");
  const app = text(source, "PGPASSWORD_APP");
  const identity = text(source, "PGPASSWORD_IDENTITY");
  const platform = text(source, "PGPASSWORD_PLATFORM");
  if (
    host === undefined ||
    port === undefined ||
    database === undefined ||
    user === undefined ||
    master === undefined ||
    app === undefined ||
    identity === undefined ||
    platform === undefined
  ) {
    return undefined;
  }
  return { host, port, database, user, master, app, identity, platform };
}

/** The image's RDS CA bundle, or undefined when it cannot be read. */
export function loadImageCa(
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): string | undefined {
  try {
    return read(IMAGE_CERT_PATH);
  } catch {
    return undefined;
  }
}
