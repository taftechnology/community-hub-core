import { createServer as createHttpServer, type Server } from "node:http";

import {
  checkContext,
  ContextRejected,
  readContract,
  type KmsContext,
} from "@community-hub/kms-broker";

export type BrokerKms = {
  generateDataKey(
    input: { keyId: string; context: KmsContext },
    opts: { abortSignal: AbortSignal },
  ): Promise<{ plaintext: Uint8Array; blob: Uint8Array }>;
  decrypt(
    input: { keyId: string; blob: Uint8Array; context: KmsContext },
    opts: { abortSignal: AbortSignal },
  ): Promise<Uint8Array>;
};

export type CreateServerDeps = {
  kms: BrokerKms;
  envelopeKeyArn: string;
  deadlineMs?: number;
  log?: (line: Record<string, string>) => void;
};

const ENVELOPE_ARN_PATTERN = /^arn:aws:kms:ap-southeast-2:[0-9]{12}:key\/.+$/;

export function assertEnvelopeKeyArn(value: string): string {
  if (!ENVELOPE_ARN_PATTERN.test(value)) {
    throw new Error("Invalid envelope key ARN");
  }
  return value;
}

export function createServer(deps: CreateServerDeps): {
  server: Server;
  start: (onListening?: (err?: Error) => void) => void;
  deadlineMs: number;
} {
  const contract = readContract();
  const deadlineMs = deps.deadlineMs ?? 3000;
  const logLine = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const errorBody = JSON.stringify(contract.error.body);
  const cacheControl = contract.responseHeaders["cache-control"];
  const maxBodyBytes = contract.limits.maxBodyBytes;

  const server = createHttpServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    res.setHeader("cache-control", cacheControl);

    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "GET" && url === "/health") {
      logLine({ operation: "health", outcome: "ok" });
      res.statusCode = 200;
      res.end();
      return;
    }

    const isGenerate =
      method === contract.routes.generateDataKey.method &&
      url === contract.routes.generateDataKey.path;
    const isDecrypt =
      method === contract.routes.decrypt.method && url === contract.routes.decrypt.path;

    if (!isGenerate && !isDecrypt) {
      logLine({ operation: "unknown", outcome: "rejected" });
      sendError(res, 404, errorBody);
      return;
    }

    const operation = isGenerate ? "generate_data_key" : "decrypt";

    const contentType = req.headers["content-type"];
    if (!isJsonContentType(contentType)) {
      logLine({ operation, outcome: "rejected" });
      sendError(res, contract.error.statusRejected, errorBody);
      return;
    }

    const contentLengthHeader = req.headers["content-length"];
    if (contentLengthHeader !== undefined) {
      const contentLength = Number(contentLengthHeader);
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxBodyBytes) {
        logLine({ operation, outcome: "rejected" });
        sendError(res, contract.error.statusRejected, errorBody);
        req.destroy();
        return;
      }
    }

    const bodyResult = await readBody(req, maxBodyBytes);
    if (bodyResult === "too_large") {
      logLine({ operation, outcome: "rejected" });
      sendError(res, contract.error.statusRejected, errorBody);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyResult.toString("utf8"));
    } catch {
      logLine({ operation, outcome: "rejected" });
      sendError(res, contract.error.statusRejected, errorBody);
      return;
    }

    const keyKind = extractKeyKind(parsed);
    const logFields = (outcome: string): Record<string, string> => {
      const line: Record<string, string> = { operation, outcome };
      if (keyKind !== undefined) {
        line.key_kind = keyKind;
      }
      return line;
    };

    if (parsed === null || typeof parsed !== "object") {
      logLine(logFields("rejected"));
      sendError(res, contract.error.statusRejected, errorBody);
      return;
    }

    const record = parsed as Record<string, unknown>;
    if (record.keyId !== contract.logicalKeyId) {
      logLine(logFields("rejected"));
      sendError(res, contract.error.statusRejected, errorBody);
      return;
    }

    let context: KmsContext;
    try {
      context = checkContext(record.context);
    } catch (error) {
      if (error instanceof ContextRejected) {
        logLine(logFields("rejected"));
        sendError(res, contract.error.statusRejected, errorBody);
        return;
      }
      throw error;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deadlineMs);
    const abortPromise = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      controller.signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });

    try {
      if (isGenerate) {
        const kmsPromise = deps.kms.generateDataKey(
          { keyId: deps.envelopeKeyArn, context },
          { abortSignal: controller.signal },
        );
        attachLateGenerateZero(controller.signal, kmsPromise);
        const result = await Promise.race([kmsPromise, abortPromise]);
        rejectIfAborted(controller.signal, result);
        if (result.plaintext.byteLength !== 32) {
          zeroGenerateMaterial(result);
          logLine(logFields("failed"));
          sendError(res, contract.error.statusFailed, errorBody);
          return;
        }
        const plaintextEncoded = Buffer.from(result.plaintext.slice()).toString("base64");
        const blobEncoded = Buffer.from(result.blob.slice()).toString("base64");
        zeroBytes(result.plaintext);
        zeroBytes(result.blob);
        const payload = JSON.stringify({
          plaintext: plaintextEncoded,
          blob: blobEncoded,
        });
        logLine(logFields("ok"));
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(payload);
        return;
      }

      if (typeof record.blob !== "string") {
        logLine(logFields("rejected"));
        sendError(res, contract.error.statusRejected, errorBody);
        return;
      }
      let blob: Uint8Array;
      try {
        blob = Uint8Array.from(Buffer.from(record.blob, "base64"));
      } catch {
        logLine(logFields("rejected"));
        sendError(res, contract.error.statusRejected, errorBody);
        return;
      }

      const kmsPromise = deps.kms.decrypt(
        { keyId: deps.envelopeKeyArn, blob, context },
        { abortSignal: controller.signal },
      );
      attachLateDecryptZero(controller.signal, kmsPromise);
      const plaintext = await Promise.race([kmsPromise, abortPromise]);
      rejectIfAborted(controller.signal, { plaintext });
      if (plaintext.byteLength !== 32) {
        zeroBytes(plaintext);
        logLine(logFields("failed"));
        sendError(res, contract.error.statusFailed, errorBody);
        return;
      }
      const plaintextEncoded = Buffer.from(plaintext.slice()).toString("base64");
      zeroBytes(plaintext);
      logLine(logFields("ok"));
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ plaintext: plaintextEncoded }));
    } catch {
      logLine(logFields("failed"));
      sendError(res, contract.error.statusFailed, errorBody);
    } finally {
      clearTimeout(timeout);
    }
  }

  function start(onListening?: (err?: Error) => void): void {
    const [host, portString] = contract.listen.split(":");
    const port = Number(portString);
    server.once("error", (err) => onListening?.(err));
    server.listen(port, host, () => onListening?.());
  }

  return { server, start, deadlineMs };
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) {
    return false;
  }
  const mediaType = raw.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function sendError(res: import("node:http").ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(body);
}

async function readBody(
  req: import("node:http").IncomingMessage,
  maxBytes: number,
): Promise<Buffer | "too_large"> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      req.resume();
      return "too_large";
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function extractKeyKind(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const context = (parsed as Record<string, unknown>).context;
  if (context === null || typeof context !== "object") {
    return undefined;
  }
  const keyKind = (context as Record<string, unknown>).key_kind;
  return typeof keyKind === "string" ? keyKind : undefined;
}

function zeroBytes(value: Uint8Array): void {
  value.fill(0);
}

function zeroGenerateMaterial(material: { plaintext: Uint8Array; blob: Uint8Array }): void {
  zeroBytes(material.plaintext);
  zeroBytes(material.blob);
}

function rejectIfAborted(
  signal: AbortSignal,
  material: { plaintext: Uint8Array; blob?: Uint8Array },
): void {
  if (!signal.aborted) {
    return;
  }
  zeroBytes(material.plaintext);
  if (material.blob !== undefined) {
    zeroBytes(material.blob);
  }
  throw new Error("aborted");
}

function attachLateGenerateZero(
  signal: AbortSignal,
  promise: Promise<{ plaintext: Uint8Array; blob: Uint8Array }>,
): void {
  void promise.then(
    (result) => {
      if (signal.aborted) {
        zeroGenerateMaterial(result);
      }
    },
    () => {},
  );
}

function attachLateDecryptZero(signal: AbortSignal, promise: Promise<Uint8Array>): void {
  void promise.then(
    (plaintext) => {
      if (signal.aborted) {
        zeroBytes(plaintext);
      }
    },
    () => {},
  );
}
