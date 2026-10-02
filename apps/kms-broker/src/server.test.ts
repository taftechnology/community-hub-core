import { request as httpRequest } from "node:http";

import { readContract } from "@community-hub/kms-broker";
import { describe, expect, it } from "vitest";

import {
  assertEnvelopeKeyArn,
  createServer,
  type BrokerKms,
  type CreateServerDeps,
} from "./server.js";

const contract = readContract();
const ENVELOPE_ARN = "arn:aws:kms:ap-southeast-2:123456789012:key/broker-test-envelope";
const ERROR_BODY = JSON.stringify(contract.error.body);
const CACHE_CONTROL = contract.responseHeaders["cache-control"];

type StoredEntry = {
  plaintext: Uint8Array;
  context: Record<string, string>;
};

function contextKey(context: Record<string, string>): string {
  return JSON.stringify(context);
}

function toEncryptionContext(
  ctx:
    | { key_kind: "org"; org_id: string; key_version: string }
    | { key_kind: "identity"; region: string; key_version: string },
): Record<string, string> {
  if (ctx.key_kind === "org") {
    return { key_kind: "org", org_id: ctx.org_id, key_version: ctx.key_version };
  }
  return { key_kind: "identity", region: ctx.region, key_version: ctx.key_version };
}

function createFakeKms(options?: {
  onGenerate?: () => void;
  onDecrypt?: () => void;
  generateError?: Error;
  decryptError?: Error;
  hang?: boolean;
}): { kms: BrokerKms; calls: { generate: unknown[]; decrypt: unknown[] }; entries: Map<string, StoredEntry> } {
  const calls = { generate: [] as unknown[], decrypt: [] as unknown[] };
  const entries = new Map<string, StoredEntry>();

  const kms: BrokerKms = {
    async generateDataKey(input, opts) {
      calls.generate.push({ input, aborted: opts.abortSignal.aborted });
      if (options?.hang) {
        await new Promise<void>(() => {});
      }
      if (options?.generateError) {
        throw options.generateError;
      }
      options?.onGenerate?.();
      if (opts.abortSignal.aborted) {
        throw new Error("aborted");
      }
      const enc = toEncryptionContext(input.context);
      const plaintext = crypto.getRandomValues(new Uint8Array(32));
      const blob = crypto.getRandomValues(new Uint8Array(48));
      const storedPlaintext = plaintext.slice();
      const storedBlob = blob.slice();
      entries.set(Buffer.from(storedBlob).toString("base64"), {
        plaintext: storedPlaintext,
        context: enc,
      });
      return { plaintext: storedPlaintext.slice(), blob: storedBlob.slice() };
    },
    async decrypt(input, opts) {
      calls.decrypt.push({ input, aborted: opts.abortSignal.aborted });
      if (options?.hang) {
        await new Promise<void>(() => {});
      }
      if (options?.decryptError) {
        throw options.decryptError;
      }
      options?.onDecrypt?.();
      if (opts.abortSignal.aborted) {
        throw new Error("aborted");
      }
      const blobKey = Buffer.from(input.blob).toString("base64");
      const entry = entries.get(blobKey);
      const enc = toEncryptionContext(input.context);
      if (!entry || contextKey(entry.context) !== contextKey(enc)) {
        throw new Error("decrypt failed");
      }
      return entry.plaintext.slice();
    },
  };

  return { kms, calls, entries };
}

async function withBroker(
  deps: Omit<CreateServerDeps, "envelopeKeyArn"> & { envelopeKeyArn?: string },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const serverDeps: CreateServerDeps = {
    envelopeKeyArn: deps.envelopeKeyArn ?? ENVELOPE_ARN,
    kms: deps.kms,
  };
  if (deps.deadlineMs !== undefined) {
    serverDeps.deadlineMs = deps.deadlineMs;
  }
  if (deps.log !== undefined) {
    serverDeps.log = deps.log;
  }
  const { server, start } = createServer(serverDeps);
  await new Promise<void>((resolve, reject) => {
    start((err?: Error) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
  const [host, port] = contract.listen.split(":");
  const baseUrl = `http://${host}:${port}`;
  try {
    await run(baseUrl);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function jsonHeaders(extra?: Record<string, string>): Record<string, string> {
  return { connection: "close", "content-type": "application/json", ...extra };
}

function brokerFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("connection", "close");
  return fetch(url, { ...init, headers });
}

describe("assertEnvelopeKeyArn", () => {
  it("rejects missing and us-east-1 ARNs", () => {
    expect(() => assertEnvelopeKeyArn("")).toThrow();
    expect(() => assertEnvelopeKeyArn("arn:aws:kms:us-east-1:123456789012:key/abc")).toThrow();
    expect(assertEnvelopeKeyArn(ENVELOPE_ARN)).toBe(ENVELOPE_ARN);
  });
});

describe("createServer", () => {
  it("defaults deadlineMs to 3000 without sleeping", () => {
    const { kms } = createFakeKms();
    const { server, deadlineMs } = createServer({ kms, envelopeKeyArn: ENVELOPE_ARN });
    expect(deadlineMs).toBe(3000);
    server.close();
  });

  it("listens on 127.0.0.1:8080", async () => {
    const { kms } = createFakeKms();
    await withBroker({ kms }, async (baseUrl) => {
      expect(baseUrl).toBe("http://127.0.0.1:8080");
    });
  });

  it("GET /health is 200, empty, and does not call KMS", async () => {
    const { kms, calls } = createFakeKms();
    await withBroker({ kms }, async (baseUrl) => {
      const res = await brokerFetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
      expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL);
      expect(calls.generate).toHaveLength(0);
      expect(calls.decrypt).toHaveLength(0);
    });
  });

  it("returns 404 for disallowed routes without calling KMS", async () => {
    const { kms, calls } = createFakeKms();
    await withBroker({ kms }, async (baseUrl) => {
      for (const path of ["/v1/decrypt", "/v1/generate-data-key", "/anything"]) {
        const method = path === "/v1/generate-data-key" ? "PUT" : "GET";
        const res = await brokerFetch(`${baseUrl}${path}`, { method });
        expect(res.status).toBe(404);
        expect(await res.text()).toBe(ERROR_BODY);
        expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL);
      }
      expect(calls.generate).toHaveLength(0);
      expect(calls.decrypt).toHaveLength(0);
    });
  });

  it("generateDataKey with org and identity contexts calls KMS once each with the envelope ARN", async () => {
    const { kms, calls } = createFakeKms();
    await withBroker({ kms }, async (baseUrl) => {
      const orgRes = await brokerFetch(`${baseUrl}/v1/generate-data-key`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          keyId: "envelope",
          context: { key_kind: "org", org_id: "org-abc", key_version: "v1" },
        }),
      });
      expect(orgRes.status).toBe(200);
      const orgBody = (await orgRes.json()) as { plaintext: string; blob: string };
      expect(Buffer.from(orgBody.plaintext, "base64")).toHaveLength(32);
      expect(orgBody.blob.length).toBeGreaterThan(0);

      const idRes = await brokerFetch(`${baseUrl}/v1/generate-data-key`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          keyId: "envelope",
          context: { key_kind: "identity", region: "au", key_version: "v2" },
        }),
      });
      expect(idRes.status).toBe(200);

      expect(calls.generate).toHaveLength(2);
      for (const call of calls.generate) {
        const input = (call as { input: { keyId: string } }).input;
        expect(input.keyId).toBe(ENVELOPE_ARN);
      }
    });
  });

  it("decrypt returns the same plaintext and rejects wrong context or tampered blob", async () => {
    const { kms, calls } = createFakeKms();
    await withBroker({ kms }, async (baseUrl) => {
      const gen = await brokerFetch(`${baseUrl}/v1/generate-data-key`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          keyId: "envelope",
          context: { key_kind: "org", org_id: "org-roundtrip", key_version: "v1" },
        }),
      });
      const { plaintext, blob } = (await gen.json()) as { plaintext: string; blob: string };

      const ok = await brokerFetch(`${baseUrl}/v1/decrypt`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          keyId: "envelope",
          blob,
          context: { key_kind: "org", org_id: "org-roundtrip", key_version: "v1" },
        }),
      });
      expect(ok.status).toBe(200);
      expect((await ok.json()).plaintext).toBe(plaintext);
      expect(calls.decrypt).toHaveLength(1);

      const badCtx = await brokerFetch(`${baseUrl}/v1/decrypt`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          keyId: "envelope",
          blob,
          context: { key_kind: "org", org_id: "org-other", key_version: "v1" },
        }),
      });
      expect(badCtx.status).toBe(502);
      expect(await badCtx.text()).toBe(ERROR_BODY);

      const tampered = Buffer.from(blob, "base64");
      if (tampered.length === 0) {
        throw new Error("expected non-empty blob");
      }
      tampered.writeUInt8(tampered[0]! ^ 0xff, 0);
      const badBlob = await brokerFetch(`${baseUrl}/v1/decrypt`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          keyId: "envelope",
          blob: tampered.toString("base64"),
          context: { key_kind: "org", org_id: "org-roundtrip", key_version: "v1" },
        }),
      });
      expect(badBlob.status).toBe(502);
      expect(await badBlob.text()).toBe(ERROR_BODY);
    });
  });

  it("rejects invalid requests with 400 and does not call KMS", async () => {
    const { kms, calls } = createFakeKms();
    const rejectBodies = [
      { keyId: "envelope", context: {} },
      { keyId: "envelope", context: { key_kind: "org", org_id: "o" } },
      {
        keyId: "envelope",
        context: { key_kind: "org", org_id: "o", region: "au", key_version: "v1" },
      },
      { keyId: "envelope", context: { key_kind: "org", key_version: "v1" } },
      {
        keyId: "envelope",
        context: { key_kind: "org", org_id: "o", key_version: "v1", extra: "x" },
      },
      { keyId: "envelope", context: { key_kind: "bad", org_id: "o", key_version: "v1" } },
      { keyId: "other", context: { key_kind: "org", org_id: "o", key_version: "v1" } },
    ];

    await withBroker({ kms }, async (baseUrl) => {
      for (const body of rejectBodies) {
        const res = await brokerFetch(`${baseUrl}/v1/generate-data-key`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toBe(ERROR_BODY);
        expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL);
      }
      expect(calls.generate).toHaveLength(0);
    });
  });

  it("rejects Content-Length over 65536 before reading the body", async () => {
    const { kms, calls } = createFakeKms();
    await withBroker({ kms }, async () => {
      const [host, port] = contract.listen.split(":");
      const res = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host,
            port: Number(port),
            method: "POST",
            path: "/v1/generate-data-key",
            headers: {
              connection: "close",
              "content-type": "application/json",
              "content-length": String(65537),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(chunk as Buffer));
            response.on("end", () => {
              const result: { statusCode?: number; body: string } = {
                body: Buffer.concat(chunks).toString("utf8"),
              };
              if (response.statusCode !== undefined) {
                result.statusCode = response.statusCode;
              }
              resolve(result);
            });
          },
        );
        req.on("error", reject);
        req.end("{}");
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toBe(ERROR_BODY);
      expect(calls.generate).toHaveLength(0);
    });
  });

  it("stops chunked bodies at 65536 bytes", async () => {
    const { kms, calls } = createFakeKms();
    await withBroker({ kms }, async () => {
      const [host, port] = contract.listen.split(":");
      const res = await new Promise<{ statusCode?: number; body: string; headers: Record<string, string> }>(
        (resolve, reject) => {
          const req = httpRequest(
            {
              host,
              port: Number(port),
              method: "POST",
              path: "/v1/generate-data-key",
              headers: {
                connection: "close",
                "content-type": "application/json",
                "transfer-encoding": "chunked",
              },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk) => chunks.push(chunk as Buffer));
              response.on("end", () => {
                const result: {
                  statusCode?: number;
                  body: string;
                  headers: Record<string, string>;
                } = {
                  body: Buffer.concat(chunks).toString("utf8"),
                  headers: response.headers as Record<string, string>,
                };
                if (response.statusCode !== undefined) {
                  result.statusCode = response.statusCode;
                }
                resolve(result);
              });
            },
          );
          req.on("error", reject);
          const chunk = "a".repeat(65537);
          req.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
          req.write("0\r\n\r\n");
          req.end();
        },
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toBe(ERROR_BODY);
      expect(res.headers["cache-control"]).toBe(CACHE_CONTROL);
      expect(calls.generate).toHaveLength(0);
    });
  });

  it("maps AWS errors to 502 without leaking ARN or org_id in body or logs", async () => {
    const sensitive = `failed ${ENVELOPE_ARN} org-abc`;
    const logs: string[] = [];
    const { kms } = createFakeKms({
      generateError: new Error(sensitive),
    });
    await withBroker(
      {
        kms,
        log: (line) => logs.push(JSON.stringify(line)),
      },
      async (baseUrl) => {
        const res = await brokerFetch(`${baseUrl}/v1/generate-data-key`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            keyId: "envelope",
            context: { key_kind: "org", org_id: "org-abc", key_version: "v1" },
          }),
        });
        expect(res.status).toBe(502);
        expect(await res.text()).toBe(ERROR_BODY);
        expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL);
        expect(logs.join("\n")).not.toContain(ENVELOPE_ARN);
        expect(logs.join("\n")).not.toContain("org-abc");
      },
    );
  });

  it("logs exactly operation, key_kind, and outcome on success", async () => {
    const logs: unknown[] = [];
    const { kms } = createFakeKms();
    await withBroker(
      {
        kms,
        log: (line) => logs.push(line),
      },
      async (baseUrl) => {
        const res = await brokerFetch(`${baseUrl}/v1/generate-data-key`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            keyId: "envelope",
            context: { key_kind: "org", org_id: "org-log", key_version: "v1" },
          }),
        });
        expect(res.status).toBe(200);
        expect(logs).toHaveLength(1);
        expect(Object.keys(logs[0] as object).sort()).toEqual(["key_kind", "operation", "outcome"]);
      },
    );
  });

  it("aborts a hanging KMS call when deadlineMs is 1", async () => {
    const abortSignals: AbortSignal[] = [];
    const kms: BrokerKms = {
      generateDataKey(_input, opts) {
        abortSignals.push(opts.abortSignal);
        return new Promise(() => {});
      },
      decrypt() {
        return new Promise(() => {});
      },
    };

    await withBroker({ kms, deadlineMs: 1 }, async (baseUrl) => {
      const started = Date.now();
      const res = await brokerFetch(`${baseUrl}/v1/generate-data-key`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          keyId: "envelope",
          context: { key_kind: "org", org_id: "org-deadline", key_version: "v1" },
        }),
      });
      expect(Date.now() - started).toBeLessThan(500);
      expect(res.status).toBe(502);
      expect(await res.text()).toBe(ERROR_BODY);
      expect(abortSignals[0]?.aborted).toBe(true);
    });
  });

  it("rejects wrong content-type and non-JSON with 400", async () => {
    const { kms, calls } = createFakeKms();
    await withBroker({ kms }, async (baseUrl) => {
      const wrongType = await brokerFetch(`${baseUrl}/v1/generate-data-key`, {
        method: "POST",
        headers: { connection: "close", "content-type": "text/plain" },
        body: "not json",
      });
      expect(wrongType.status).toBe(400);
      expect(await wrongType.text()).toBe(ERROR_BODY);

      const notJson = await brokerFetch(`${baseUrl}/v1/generate-data-key`, {
        method: "POST",
        headers: jsonHeaders(),
        body: "{",
      });
      expect(notJson.status).toBe(400);
      expect(await notJson.text()).toBe(ERROR_BODY);
      expect(calls.generate).toHaveLength(0);
    });
  });

  it("returns 502 when plaintext is not 32 bytes", async () => {
    const kms: BrokerKms = {
      async generateDataKey() {
        return { plaintext: new Uint8Array(16), blob: new Uint8Array(8) };
      },
      async decrypt() {
        return new Uint8Array(16);
      },
    };
    await withBroker({ kms }, async (baseUrl) => {
      const res = await brokerFetch(`${baseUrl}/v1/generate-data-key`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          keyId: "envelope",
          context: { key_kind: "org", org_id: "org-short", key_version: "v1" },
        }),
      });
      expect(res.status).toBe(502);
      expect(await res.text()).toBe(ERROR_BODY);
    });
  });
});
