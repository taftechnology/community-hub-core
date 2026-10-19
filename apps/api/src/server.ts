import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { createLogger } from "@community-hub/observability";

import { createGate, type GateRoute } from "./gate.js";
import type { ServiceEnv } from "./env.js";

export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const ACCEPT_AFTER_SIGTERM_MS = 5_000;
export const FORCE_CLOSE_AFTER_SIGTERM_MS = 25_000;

export type SignalSource = {
  on(signal: "SIGTERM", listener: () => void): void;
};

const logger = createLogger();
const POST_BODY_MAX_BYTES = 4096;
const WEBHOOK_BODY_MAX_BYTES = 262_144;

function presentedHostnameFromReq(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-community-hub-hostname"];
  if (typeof raw === "string" && raw.length > 0) {
    return raw.toLowerCase();
  }
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string" && raw[0].length > 0) {
    return raw[0].toLowerCase();
  }
  return undefined;
}

function requestFrom(req: IncomingMessage, body?: Uint8Array): Request {
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
    ...(body === undefined ? {} : { body }),
  });
}

async function readPostBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array | "over"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.byteLength;
    if (size > maxBytes) {
      return "over";
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
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
  requestTimeoutMs?: number;
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
    if (!req.complete) {
      const timer = setTimeout(() => {
        if (!req.complete) {
          req.socket?.destroy();
        }
      }, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      timer.unref();
      const clear = () => clearTimeout(timer);
      req.on("end", clear);
      req.on("close", clear);
    }
    void (async () => {
      try {
        let body: Uint8Array | undefined;
        if (req.method === "POST") {
          const pathname = new URL(`http://127.0.0.1${req.url ?? "/"}`).pathname;
          const isLargeBodyRoute = options.routes.some(
            (route) =>
              route.method === "POST" &&
              route.pattern === pathname &&
              route.largeBody === "webhooks",
          );
          const presentedHost = presentedHostnameFromReq(req);
          const isWebhookHost =
            presentedHost !== undefined &&
            presentedHost === options.env.WEBHOOKS_HOSTNAME.toLowerCase();

          const isLargeBody = isLargeBodyRoute && isWebhookHost;
          const maxBytes = isLargeBody ? WEBHOOK_BODY_MAX_BYTES : POST_BODY_MAX_BYTES;

          const read = await readPostBody(req, maxBytes);
          if (read === "over") {
            const status = isLargeBody ? 413 : 400;
            if (!res.headersSent && !res.writableEnded && !res.socket?.destroyed) {
              res.writeHead(status, { "Content-Length": "0" });
              res.end();
            }
            req.destroy();
            return;
          }
          body = read;
        }
        const remoteAddress = req.socket.remoteAddress ?? "";
        const response = await gate({ request: requestFrom(req, body), remoteAddress });
        if (!res.writableEnded) {
          await writeResponse(res, response);
        }
      } catch {
        if (res.socket?.destroyed) {
          return;
        }
        if (res.headersSent) {
          res.socket?.destroy();
        } else if (!res.writableEnded) {
          res.writeHead(400, { "Content-Length": "0" });
          res.end();
        }
      }
    })();
  });
  server.requestTimeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.listen(options.env.PORT, "0.0.0.0");

  const signals = options.signals ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const acceptForMs = options.acceptForMs ?? ACCEPT_AFTER_SIGTERM_MS;
  const forceCloseMs = options.forceCloseMs ?? FORCE_CLOSE_AFTER_SIGTERM_MS;
  signals.on("SIGTERM", () => {
    setTimeout(() => {
      server.close(() => {
        exit(0);
      });
    }, acceptForMs);
    setTimeout(() => {
      server.closeAllConnections();
    }, forceCloseMs);
  });

  return server;
}
