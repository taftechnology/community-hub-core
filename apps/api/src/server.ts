import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { createLogger } from "@community-hub/observability";

import { createGate, type GateRoute } from "./gate.js";
import type { ServiceEnv } from "./env.js";

export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 66_000;
export const ACCEPT_AFTER_SIGTERM_MS = 5_000;
export const FORCE_CLOSE_AFTER_SIGTERM_MS = 25_000;

export type SignalSource = {
  on(signal: "SIGTERM", listener: () => void): void;
};

const logger = createLogger();

function requestFrom(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    }
  }
  const path = req.url ?? "/";
  return new Request(`http://127.0.0.1${path}`, {
    method: req.method ?? "GET",
    headers,
  });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const bytes = Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  res.end(bytes);
}

export function startServer(options: {
  env: ServiceEnv;
  routes: readonly GateRoute[];
  signals?: SignalSource;
  exit?: (code: number) => void;
  acceptForMs?: number;
  forceCloseMs?: number;
}): Server {
  const gate = createGate({
    hostnames: {
      api: options.env.API_HOSTNAME,
      auth: options.env.AUTH_HOSTNAME,
      webhooks: options.env.WEBHOOKS_HOSTNAME,
      ops: options.env.OPS_HOSTNAME,
    },
    routes: options.routes,
    info: (message, fields) => {
      logger.info(message, fields);
    },
  });
  const server = createServer((req, res) => {
    void (async () => {
      const remoteAddress = req.socket.remoteAddress ?? "";
      const response = await gate({ request: requestFrom(req), remoteAddress });
      if (!res.writableEnded) {
        await writeResponse(res, response);
      }
    })();
  });
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.listen(options.env.PORT, "0.0.0.0");

  const signals = options.signals ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const acceptForMs = options.acceptForMs ?? ACCEPT_AFTER_SIGTERM_MS;
  const forceCloseMs = options.forceCloseMs ?? FORCE_CLOSE_AFTER_SIGTERM_MS;
  signals.on("SIGTERM", () => {
    setTimeout(() => {
      server.close();
    }, acceptForMs);
    setTimeout(() => {
      server.closeAllConnections();
      exit(0);
    }, forceCloseMs);
  });

  return server;
}
