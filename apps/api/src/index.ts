import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";

import { healthRequest } from "@community-hub/kernel";

import { readServiceEnv, IMAGE_CERT_PATH } from "./env.js";
import { RoutesRejected, type GateRoute } from "./gate.js";
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
    current = startServer({ env: read.env, routes });
  } catch (error) {
    if (error instanceof RoutesRejected) {
      process.stderr.write("routes\n");
      return 1;
    }
    throw error;
  }
  return 0;
}

const healthRoutes: readonly GateRoute[] = [
  {
    method: "GET",
    pattern: "/health",
    surface: "all",
    handle: healthRequest,
  },
];

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  boot({
    readPem: () => readFileSync(IMAGE_CERT_PATH, "utf8"),
    source: process.env,
    routes: healthRoutes,
    exit: (code) => {
      process.exit(code);
    },
  });
}
